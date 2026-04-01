process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 環境変数
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL_ROBINHOOD || "https://rpc.testnet.chain.robinhood.com";

// Provider設定（ネットワーク検知を固定して安定化）
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    staticNetwork: true
});

// ウォレット設定
let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

// ABI設定（RobinhoodSwapV3の全機能を網羅）
const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

// 通信リトライ関数（ネットワークの瞬断対策）
async function retryCall(fn, name = "Request", retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            console.log(`[Retry] ${name} failed (attempt ${i + 1}/${retries}): ${err.message}`);
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

app.post('/get-signature', async (req, res) => {
    try {
        let { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        // 【機能保持】アドレスの正規化（大文字小文字の差異を吸収）
        const cleanUser = ethers.getAddress(userAddress);
        const cleanFrom = ethers.getAddress(fromToken);
        const cleanTo = ethers.getAddress(toToken);

        console.log(`--- Request Start ---`);
        console.log(`From: ${cleanFrom} | To: ${cleanTo}`);

        // 1. コントラクトデータの取得（既存の全チェック機能を保持）
        const [fromRate, toRate, maxLimitUSD, isFromSupported, isToSupported] = await Promise.all([
            retryCall(() => contract.tokenRates(cleanFrom), "fromRate"),
            retryCall(() => contract.tokenRates(cleanTo), "toRate"),
            retryCall(() => contract.maxSwapAmountUSD(), "maxLimit"),
            retryCall(() => contract.isSupported(cleanFrom), "isFromSupported"),
            retryCall(() => contract.isSupported(cleanTo), "isToSupported")
        ]);

        // 【デバッグログ】isFromOkがfalseになる謎を解明するための詳細出力
        console.log(`Debug Results:`);
        console.log(`- ${cleanFrom.substring(0, 6)}...: Supported=${isFromSupported}, Rate=${fromRate}`);
        console.log(`- ${cleanTo.substring(0, 6)}...: Supported=${isToSupported}, Rate=${toRate}`);

        // 2. 既存のバリデーションロジック
        if (!isFromSupported || !isToSupported || fromRate === 0n || toRate === 0n) {
            return res.status(400).json({
                error: "Unsupported token or rate not set",
                details: { isFromSupported, isToSupported, fromRate: fromRate.toString(), toRate: toRate.toString() }
            });
        }

        const fromAmountBI = BigInt(fromAmount);

        // 3. 【既存機能】上限チェック (USD換算)
        // (数量 * レート) / 10^18
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(10 ** 18);
        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({
                error: "Exceeds max swap amount",
                amountUSD: ethers.formatUnits(fromAmountUSD, 18),
                limitUSD: ethers.formatUnits(maxLimitUSD, 18)
            });
        }

        // 4. 計算ロジック
        const toAmountBI = (fromAmountBI * fromRate) / toRate;

        // 5. 【修正の核心】Solidity v3と100%一致するハッシュ生成
        // msg.sender, _fromToken, _toToken, _fromAmount, _toAmount, _nonce
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [cleanUser, cleanFrom, cleanTo, fromAmountBI, toAmountBI, BigInt(nonce)]
        );

        // 6. 署名作成
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        console.log(`Signature generated successfully for nonce ${nonce}`);

        res.json({
            toAmount: toAmountBI.toString(),
            signature: signature
        });

    } catch (error) {
        console.error("Critical Server Error:", error);
        res.status(500).json({ error: "Internal Server Error", message: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`-----------------------------------------`);
    console.log(`Robinhood V3 Signer Server Active`);
    console.log(`Port: ${PORT}`);
    console.log(`Contract: ${CONTRACT_ADDRESS}`);
    console.log(`RPC: ${RPC_URL}`);
    console.log(`-----------------------------------------`);
});