// SSL証明書エラーを回避（Render環境の安定化）
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
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xd6B75904824963e33C5F85C2021F584AaA5CeB97";
const RPC_URL = "https://rpc-testnet.robinhoodchain.com";

// 安定動作していた頃のシンプルなProvider設定に戻す
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    staticNetwork: true
});

// PRIVATE_KEYの整形（0xがない場合に追加）
let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

// 全機能を保持したABI
const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        // 【改善点】Promise.allを避け、1つずつ確実に取得することでRPCの負荷（EPROTO）を抑える
        const fromRate = await contract.tokenRates(fromToken);
        const toRate = await contract.tokenRates(toToken);
        const maxLimitUSD = await contract.maxSwapAmountUSD();
        const isFromOk = await contract.isSupported(fromToken);
        const isToOk = await contract.isSupported(toToken);

        // サポートチェック
        if (!isFromOk || !isToOk) {
            return res.status(400).json({ error: "Unsupported token" });
        }

        const fromAmountBI = BigInt(fromAmount);

        // --- 保持したい新機能：上限チェック ---
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(10 ** 18);
        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({
                error: "Exceeds max swap amount limit",
                limit: ethers.formatUnits(maxLimitUSD, 18)
            });
        }

        // レートが0の場合の回避
        if (toRate === 0n) return res.status(400).json({ error: "Target rate is zero" });

        // 計算ロジック
        const toAmountBI = (fromAmountBI * fromRate) / toRate;

        // ハッシュ作成：成功していた頃の型（uint256は文字列ではなくBigIntのまま渡すのが安全）
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [userAddress, fromToken, toToken, fromAmountBI, toAmountBI, BigInt(nonce)]
        );

        // 署名
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
app.listen(PORT, () => console.log(`Signer Server running on port ${PORT}`));