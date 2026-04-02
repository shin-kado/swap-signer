require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL_ROBINHOOD || "https://rpc.testnet.chain.robinhood.com";

const provider = new ethers.JsonRpcProvider(RPC_URL);

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

// HTML側からの呼び出しに必要な全ての関数を網羅
const ABI = [
    "function isSupported(address) view returns (bool)",
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function getStock(address) view returns (uint256)",
    "function nonces(address) view returns (uint256)",
    "function getSupportedTokens() view returns (address[])"
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

        // 1. レート取得（18桁整数）
        const fromRate = BigInt(await retryCall(() => contract.tokenRates(cleanFrom), "getFromRate"));
        const toRate = BigInt(await retryCall(() => contract.tokenRates(cleanTo), "getToRate"));

        if (toRate === 0n) return res.status(400).json({ error: "Invalid toToken rate" });

        // 2. スワップ上限チェック
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(1e18);
        const maxSwapUSD = BigInt(await retryCall(() => contract.maxSwapAmountUSD(), "getMaxSwap"));
        if (fromAmountUSD > maxSwapUSD) return res.status(400).json({ error: "Exceeds max swap amount" });

        // 3. 数量計算と在庫チェック
        const toAmountBI = (fromAmountBI * fromRate) / toRate;
        const actualStock = BigInt(await retryCall(() => contract.getStock(cleanTo), "getStock"));

        // ログ用のフォーマット（ここで定義することで、どこでも使えるようにします）
        const fromReadable = ethers.formatUnits(fromAmountBI, 18);
        const toReadable = ethers.formatUnits(toAmountBI, 18);
        const stockReadable = ethers.formatUnits(actualStock, 18);

        if (actualStock < toAmountBI) {
            console.log(`Insufficient Stock: Required ${toReadable} > Available ${stockReadable}`);
            return res.status(400).json({
                error: "Insufficient liquidity",
                message: `在庫不足: 必要量 ${toReadable} / 在庫 ${stockReadable}`
            });
        }

        // 4. 署名作成
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [cleanUser, cleanFrom, cleanTo, fromAmountBI, toAmountBI, BigInt(nonce)]
        );
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        console.log(`Success: Generated signature for ${fromReadable} -> ${toReadable}`);

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