process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 通信エラー回避
require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- 設定 ---
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
// 以前成功していたURLに戻します
const RPC_URL = "https://rpc.testnet.chain.robinhood.com";

// 以前のシンプルなProvider作成に戻します
const provider = new ethers.JsonRpcProvider(RPC_URL);

// 秘密鍵の補完
let finalKey = PRIVATE_KEY;
if (finalKey && !finalKey.startsWith('0x')) {
    finalKey = '0x' + finalKey;
}
const wallet = new ethers.Wallet(finalKey, provider);

const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;
        const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

        // レートとサポート状況の取得
        const [rateFrom, rateTo, isFromOk, isToOk] = await Promise.all([
            contract.tokenRates(fromToken),
            contract.tokenRates(toToken),
            contract.isSupported(fromToken),
            contract.isSupported(toToken)
        ]);

        if (!isFromOk || !isToOk || rateFrom === 0n || rateTo === 0n) {
            return res.status(400).json({ error: "Unsupported token or rate not set" });
        }

        const fromAmountBI = BigInt(fromAmount);
        const toAmountBI = (fromAmountBI * rateFrom) / rateTo;

        // ハッシュ作成：以前のコード通り toAmountBI (BigInt) を直接渡す形式に戻します
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
        console.error("Signature Error:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// Renderの標準ポート10000を使用
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Signer running on port ${PORT}`));