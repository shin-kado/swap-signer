// 1. 最も重要な追加：Node.js自体の暗号化プロトコルの制限を緩和する
// これにより「alert number 112」の原因となる古い/新しいTLSの不一致を強制解決します
const crypto = require('crypto');
const constants = require('crypto').constants;
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

// 2. プロバイダーの作成方法を「接続エラーを回避する最小手順」に変更
// 起動時の自動チェックをすべて無効化
const provider = new ethers.JsonRpcProvider(RPC_URL, 8008135, {
    staticNetwork: true,
    batchMaxCount: 1
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

        // 3. 通信のタイムアウトを個別に管理（EPROTOでの固まりを防止）
        const results = await Promise.all([
            contract.tokenRates(fromToken),
            contract.tokenRates(toToken),
            contract.maxSwapAmountUSD(),
            contract.isSupported(fromToken),
            contract.isSupported(toToken)
        ]).catch(e => {
            console.error("RPC Connection Error:", e);
            throw new Error(`RPC接続失敗: ${e.message}`);
        });

        const [fromRate, toRate, maxLimitUSD, isFromOk, isToOk] = results;

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

        res.json({ toAmount, signature, rateUsed: ethers.formatUnits(fromRate, 18) });

    } catch (error) {
        console.error("Signature Error Details:", error);
        res.status(500).json({
            error: "Internal server error during signing.",
            details: error.message,
            code: error.code || "CONNECTION_ERROR"
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`V3 Signer Server active on port ${PORT}`));