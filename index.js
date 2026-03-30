const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Renderの環境変数から取得
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = "https://testnet-rpc.monad.xyz";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// 新コントラクト参照用の最小限のABI
const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;
        const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

        // --- 修正の核心：コントラクトから最新レートを直接取得 ---
        const [rateFrom, rateTo, isFromOk, isToOk] = await Promise.all([
            contract.tokenRates(fromToken),
            contract.tokenRates(toToken),
            contract.isSupported(fromToken),
            contract.isSupported(toToken)
        ]);

        if (!isFromOk || !isToOk || rateFrom === 0n || rateTo === 0n) {
            return res.status(400).json({ error: "Unsupported token or rate not set" });
        }

        // 計算ロジック（BigIntで精密に計算）
        const fromAmountBI = BigInt(fromAmount);
        const toAmountBI = (fromAmountBI * rateFrom) / rateTo;

        // ハッシュ作成と署名
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [userAddress, fromToken, toToken, fromAmount, toAmountBI, nonce]
        );
        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        res.json({
            toAmount: toAmountBI.toString(),
            signature: signature
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Self-Sovereign Signer running on port ${PORT}`));