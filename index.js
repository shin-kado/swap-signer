require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL_ROBINHOOD || "https://rpc-testnet.robinhoodchain.com";

const provider = new ethers.JsonRpcProvider(RPC_URL);

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

// 最新の RobinhoodSwap_v4.sol に準拠したABI
const ABI = [
    "function isSupported(address) view returns (bool)",
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function getStock(address) view returns (uint256)",
    "function nonces(address) view returns (uint256)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

async function retryCall(fn, name = "Request", retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            console.error(`[${name}] Attempt ${i + 1} failed:`, err.message);
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        if (!userAddress || !fromToken || !toToken || !fromAmount || !nonce) {
            return res.status(400).json({ error: "Missing parameters" });
        }

        const cleanUser = ethers.getAddress(userAddress);
        const cleanFrom = ethers.getAddress(fromToken);
        const cleanTo = ethers.getAddress(toToken);
        const fromAmountBI = BigInt(fromAmount);

        // 1. サポート確認
        const isFromSupported = await retryCall(() => contract.isSupported(cleanFrom), "checkFromSupport");
        const isToSupported = await retryCall(() => contract.isSupported(cleanTo), "checkToSupport");

        if (!isFromSupported || !isToSupported) {
            return res.status(400).json({ error: "Token not supported" });
        }

        // 2. コントラクトから最新レートを取得（整数/Wei単位）
        const fromRate = BigInt(await retryCall(() => contract.tokenRates(cleanFrom), "getFromRate"));
        const toRate = BigInt(await retryCall(() => contract.tokenRates(cleanTo), "getToRate"));

        if (toRate === 0n) {
            return res.status(400).json({ error: "Invalid toToken rate" });
        }

        // 3. スワップ上限チェック (USD換算)
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(1e18);
        const maxSwapUSD = BigInt(await retryCall(() => contract.maxSwapAmountUSD(), "getMaxSwap"));

        if (fromAmountUSD > maxSwapUSD) {
            return res.status(400).json({ error: "Exceeds max swap amount" });
        }

        // 4. スワップ後の数量計算（18桁整数ベース）
        // 式: (数量 * 入力レート) / 出力レート
        const toAmountBI = (fromAmountBI * fromRate) / toRate;

        // 5. 在庫チェック（18桁整数ベースで厳密に比較）
        const actualStock = BigInt(await retryCall(() => contract.getStock(cleanTo), "getStock"));

        if (actualStock < toAmountBI) {
            const reqReadable = ethers.formatUnits(toAmountBI, 18);
            const avlReadable = ethers.formatUnits(actualStock, 18);
            console.log(`Insufficient Stock: Required ${reqReadable} > Available ${avlReadable}`);

            return res.status(400).json({
                error: "Insufficient liquidity",
                message: `在庫不足: 必要量 ${reqReadable} に対して、現在プールには ${avlReadable} しかありません。`
            });
        }

        // 6. 署名ハッシュ作成 (Solidityの abi.encodePacked と完全一致させる)
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [cleanUser, cleanFrom, cleanTo, fromAmountBI, toAmountBI, BigInt(nonce)]
        );

        // signMessage は内部で "\x19Ethereum Signed Message:\n32" を付与します (MessageHashUtils.toEthSignedMessageHashに対応)
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        console.log(`Success: Signature generated for ${reqReadable} to ${ethers.formatUnits(toAmountBI, 18)}`);

        res.json({
            toAmount: toAmountBI.toString(),
            signature: signature
        });

    } catch (error) {
        console.error("Critical Error:", error);
        res.status(500).json({ error: "Internal server error", detail: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Signer service running on port ${PORT}`));