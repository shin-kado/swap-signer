process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
// 通信が成功した方のURLを固定で使用
const RPC_URL = "http://rpc-testnet.robinhoodchain.com";

const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    staticNetwork: true
});

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

// RobinhoodSwapV3.sol に合わせた完全なABI
const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

// リトライ関数
async function retryCall(fn, name = "Request", retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            console.log(`[Retry] ${name} failed (attempt ${i + 1}/3)`);
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        // 1. 各データの取得
        const [fromRate, toRate, maxLimitUSD, isFromOk, isToOk] = await Promise.all([
            retryCall(() => contract.tokenRates(fromToken), "fromRate"),
            retryCall(() => contract.tokenRates(toToken), "toRate"),
            retryCall(() => contract.maxSwapAmountUSD(), "maxLimit"),
            retryCall(() => contract.isSupported(fromToken), "isFromOk"),
            retryCall(() => contract.isSupported(toToken), "isToOk")
        ]);

        // 2. 厳密なバリデーション
        if (!isFromOk || !isToOk || fromRate === 0n || toRate === 0n) {
            return res.status(400).json({ error: "Token not supported or rate zero" });
        }

        const fromAmountBI = BigInt(fromAmount);

        // 3. 上限チェック (Solidityと同じロジック)
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(10 ** 18);
        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({ error: "Exceeds max swap amount" });
        }

        // 4. スワップ後数量の計算
        const toAmountBI = (fromAmountBI * fromRate) / toRate;

        // 5. 【重要】Solidityの abi.encodePacked と完全に一致させる
        // solidityPackedKeccak256 を使い、型を明示的に指定します。
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [
                ethers.getAddress(userAddress), // アドレスを正規化
                ethers.getAddress(fromToken),
                ethers.getAddress(toToken),
                fromAmountBI,
                toAmountBI,
                BigInt(nonce)
            ]
        );

        // 6. 署名の作成
        // signMessageは内部で "\x19Ethereum Signed Message:\n32" を付与します。
        // これは Solidity側の MessageHashUtils.toEthSignedMessageHash と一致します。
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        res.json({
            toAmount: toAmountBI.toString(),
            signature: signature
        });

    } catch (error) {
        console.error("Signature Error:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`V3 Signer Active on port ${PORT}`));