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
const RPC_URL = "https://rpc-testnet.robinhoodchain.com"; // Robinhood Testnet RPC
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// V3でレート計算に必要な最小限のABI
const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        // 1. コントラクトから「管理者が設定した最新パラメータ」を取得
        // fromRate: 1枚あたりのUSD, toRate: 1枚あたりのUSD, maxLimit: 上限USD
        const [fromRate, toRate, maxLimitUSD, isFromOk, isToOk] = await Promise.all([
            contract.tokenRates(fromToken),
            contract.tokenRates(toToken),
            contract.maxSwapAmountUSD(),
            contract.isSupported(fromToken),
            contract.isSupported(toToken)
        ]);

        // バリデーション: サポート外のトークンは拒否
        if (!isFromOk || !isToOk) {
            return res.status(400).json({ error: "One of the tokens is not supported." });
        }

        // 2. USD換算での取引上限チェック
        const fromAmountBN = BigInt(fromAmount);
        const fromAmountUSD = (fromAmountBN * fromRate) / BigInt(10 ** 18);

        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({
                error: "Exceeds max swap amount limit (USD)",
                requestedUSD: ethers.formatUnits(fromAmountUSD, 18),
                limitUSD: ethers.formatUnits(maxLimitUSD, 18)
            });
        }

        // 3. 【重要】交換枚数 (toAmount) の自動計算
        // 公式: 入力数量 * (元のトークンのUSD価格 / 宛先トークンのUSD価格)
        // 例: AMD($1.0) -> MRT($0.1) なら 1 * (1.0 / 0.1) = 10枚
        if (toRate === BigInt(0)) return res.status(400).json({ error: "Target token rate is zero." });
        const toAmountBN = (fromAmountBN * fromRate) / toRate;
        const toAmount = toAmountBN.toString();

        // 4. 署名の作成 (V3のswap関数が要求するハッシュ形式)
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [userAddress, fromToken, toToken, fromAmount, toAmount, nonce]
        );
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        // フロントエンドに「計算された受取量」と「署名」を返す
        res.json({
            toAmount,
            signature,
            rateUsed: ethers.formatUnits(fromRate, 18) // 確認用
        });

    } catch (error) {
        console.error("Signature Error:", error);
        res.status(500).json({ error: "Internal server error during signing." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`V3 Signer Server active on port ${PORT}`));
