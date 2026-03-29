const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- 環境設定（Renderのダッシュボードで設定します） ---
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = "https://rpc-testnet.monad.xyz"; // Robinhood TestnetのRPC

// 署名用ウォレットの準備
const wallet = new ethers.Wallet(PRIVATE_KEY);

// レート計算ロジック
const TOKEN_RATES = {
    "0x196eCa072F41571233E4F6D215F89A3446DD569b": 0.0001, // MRT
    "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02": 0.5,    // AMZN
    "0x71178BAc73cBeb415514eB542a8995b82669778d": 1.0,    // AMD
    "0x3B8262a63d25F0477c4DDe23f83CfE22Cb768C93": 5.0,    // NFLX
    "0x1fFB130bCe111C47c947E99f1C946f00A9E298d0": 10.0,   // PLTR
    "0xCc9f0d691353fE40098F1559c3a30368943Bd4E4": 20.0    // TSLA
};

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        // 1. レートに基づいて受け取り量を計算
        const rateFrom = TOKEN_RATES[fromToken];
        const rateTo = TOKEN_RATES[toToken];

        if (!rateFrom || !rateTo) {
            return res.status(400).json({ error: "Unsupported token pair" });
        }

        // 交換量の計算 (例: (支払額 * 支払レート) / 受取レート)
        const fromAmountNum = parseFloat(ethers.formatUnits(fromAmount, 18));
        const toAmountNum = (fromAmountNum * rateFrom) / rateTo;
        const toAmountBaseUnit = ethers.parseUnits(toAmountNum.toFixed(18), 18);

        // 2. コントラクトの abi.encodePacked と同じ形式でハッシュ作成
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [userAddress, fromToken, toToken, fromAmount, toAmountBaseUnit, nonce]
        );

        // 3. 署名の作成
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        // 4. クライアントに返却
        res.json({
            toAmount: toAmountBaseUnit.toString(),
            signature: signature
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Signer server running on port ${PORT}`);
});