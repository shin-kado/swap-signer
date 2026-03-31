// 1. TLS/SSLエラーを力技で回避する設定
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- ネットワーク・コントラクト設定 ---
const CONTRACT_ADDRESS = "0xd6B75904824963e33C5F85C2021F584AaA5CeB97";
const RPC_URL = "https://rpc-testnet.robinhoodchain.com";

// 2. プロバイダーの通信設定を極限までシンプルにする（EPROTO対策）
// FetchRequestを使用して、接続のタイムアウトとリトライを制御します
const fetchReq = new ethers.FetchRequest(RPC_URL);
fetchReq.timeout = 15000; // 15秒でタイムアウト設定

const provider = new ethers.JsonRpcProvider(fetchReq, 8008135, {
    staticNetwork: true // ネットワークの自動検知を完全にオフにする
});

// PRIVATE_KEYの取得と補完
let privateKey = process.env.PRIVATE_KEY;
if (privateKey && !privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey;
}

const wallet = new ethers.Wallet(privateKey, provider);

const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        console.log(`[DEBUG] Attempting to fetch data for ${userAddress}`);

        // 通信エラーを特定しやすくするため、Promise.all ではなく順番に実行
        // 各工程でエラーが出ても詳細をキャッチできるようにします
        const fromRate = await contract.tokenRates(fromToken).catch(e => { throw new Error("FromRate fetch failed: " + e.message) });
        const toRate = await contract.tokenRates(toToken).catch(e => { throw new Error("ToRate fetch failed: " + e.message) });
        const maxLimitUSD = await contract.maxSwapAmountUSD().catch(e => { throw new Error("MaxLimit fetch failed: " + e.message) });
        const isFromOk = await contract.isSupported(fromToken).catch(e => { throw new Error("isFromOk fetch failed: " + e.message) });
        const isToOk = await contract.isSupported(toToken).catch(e => { throw new Error("isToOk fetch failed: " + e.message) });

        if (!isFromOk || !isToOk) {
            return res.status(400).json({ error: "One of the tokens is not supported." });
        }

        const fromAmountBN = BigInt(fromAmount);
        const fromAmountUSD = (fromAmountBN * fromRate) / BigInt(10 ** 18);

        // 上限チェックロジック（保持）
        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({
                error: "Exceeds max swap amount limit (USD)",
                requestedUSD: ethers.formatUnits(fromAmountUSD, 18),
                limitUSD: ethers.formatUnits(maxLimitUSD, 18)
            });
        }

        if (toRate === BigInt(0)) return res.status(400).json({ error: "Target token rate is zero." });
        const toAmountBN = (fromAmountBN * fromRate) / toRate;
        const toAmount = toAmountBN.toString();

        // 署名作成ロジック（保持）
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [userAddress, fromToken, toToken, fromAmount, toAmount, nonce]
        );
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        res.json({
            toAmount,
            signature,
            rateUsed: ethers.formatUnits(fromRate, 18)
        });

    } catch (error) {
        console.error("Signature Error Details:", error);
        res.status(500).json({
            error: "Internal server error during signing.",
            details: error.message,
            code: error.code || "UNKNOWN_ERROR"
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`V3 Signer Server active on port ${PORT}`);
});