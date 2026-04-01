process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xd6B75904824963e33C5F85C2021F584AaA5CeB97";
// ネットワークエラー対策：URLを変更（もし可能なら別のRPCを試す設定）
const RPC_URL = "https://rpc-testnet.robinhoodchain.com";

const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    staticNetwork: true // ネットワークの自動検知をオフにして接続を安定させる
});

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

// --- ヘルパー関数: 失敗しても3回までリトライする ---
async function retryCall(fn, name = "Request", retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            console.log(`[Retry] ${name} failed (attempt ${i + 1}/${retries})...`);
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, 1000)); // 1秒待って再試行
        }
    }
}

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        // リトライ付きで各データを取得
        const fromRate = await retryCall(() => contract.tokenRates(fromToken), "getRateFrom");
        const toRate = await retryCall(() => contract.tokenRates(toToken), "getRateTo");
        const maxLimitUSD = await retryCall(() => contract.maxSwapAmountUSD(), "getMaxLimit");
        const isFromOk = await retryCall(() => contract.isSupported(fromToken), "checkSupportFrom");
        const isToOk = await retryCall(() => contract.isSupported(toToken), "checkSupportTo");

        if (!isFromOk || !isToOk) {
            return res.status(400).json({ error: "Unsupported token" });
        }

        const fromAmountBI = BigInt(fromAmount);
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(10 ** 18);

        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({
                error: "Exceeds max swap amount limit",
                limit: ethers.formatUnits(maxLimitUSD, 18)
            });
        }

        if (toRate === 0n) return res.status(400).json({ error: "Target rate is zero" });

        const toAmountBI = (fromAmountBI * fromRate) / toRate;

        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [userAddress, fromToken, toToken, fromAmountBI, toAmountBI, BigInt(nonce)]
        );

        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        res.json({
            toAmount: toAmountBI.toString(),
            signature: signature
        });

    } catch (error) {
        console.error("Final Signature Error:", error);
        res.status(500).json({
            error: "Connection to Testnet failed. Please try again.",
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Stable Signer Server running on port ${PORT}`));