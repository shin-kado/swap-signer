// 1. 通信エラーを強制回避するための設定
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

// 2. 以前の「動いていた頃」と同じシンプルなProvider作成に戻す
// ただし、Render環境での安定化のため、最小限のオプションのみ付与
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    staticNetwork: true
});

// PRIVATE_KEYの補完
let privateKey = process.env.PRIVATE_KEY;
if (privateKey && !privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey;
}

const wallet = new ethers.Wallet(privateKey, provider);

// 全機能（上限チェック用含む）を保持したABI
const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

// コントラクトインスタンス
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        // 3. 通信の核心：安定していた頃のように順番に処理を行う（Promise.allを避ける）
        // テストネットの負荷が高い場合、一斉にリクエストを送るとEPROTOが出やすいためです
        const fromRate = await contract.tokenRates(fromToken);
        const toRate = await contract.tokenRates(toToken);
        const maxLimitUSD = await contract.maxSwapAmountUSD();
        const isFromOk = await contract.isSupported(fromToken);
        const isToOk = await contract.isSupported(toToken);

        if (!isFromOk || !isToOk) {
            return res.status(400).json({ error: "One of the tokens is not supported." });
        }

        const fromAmountBN = BigInt(fromAmount);
        const fromAmountUSD = (fromAmountBN * fromRate) / BigInt(10 ** 18);

        // --- 新機能：上限チェック（完全に保持） ---
        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({
                error: "Exceeds max swap amount limit (USD)",
                requestedUSD: ethers.formatUnits(fromAmountUSD, 18),
                limitUSD: ethers.formatUnits(maxLimitUSD, 18)
            });
        }

        if (toRate === BigInt(0)) return res.status(400).json({ error: "Target token rate is zero." });

        // 計算ロジック
        const toAmountBN = (fromAmountBN * fromRate) / toRate;
        const toAmount = toAmountBN.toString();

        // 4. 署名作成：以前の「成功していた頃」のパラメータ渡しを再現
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [userAddress, fromToken, toToken, fromAmount, toAmount, nonce]
        );

        // 署名生成
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        // レスポンス
        res.json({
            toAmount,
            signature,
            rateUsed: ethers.formatUnits(fromRate, 18)
        });

    } catch (error) {
        console.error("Signature Error:", error);
        res.status(500).json({
            error: "Internal server error during signing.",
            details: error.message
        });
    }
});

// ポート設定
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`V3 Signer Server active on port ${PORT}`));