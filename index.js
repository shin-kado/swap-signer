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

// PRIVATE_KEYの 0x 補完
let privateKey = process.env.PRIVATE_KEY;
if (privateKey && !privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey;
}

// 【修正ポイント】networkオブジェクトを明示的に作成せず、
// JsonRpcProvider に最小限の情報だけを渡します。
const provider = new ethers.JsonRpcProvider(RPC_URL, 8008135, {
    staticNetwork: true
});

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

        // 通信の安定性を高めるため、個別に await します
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
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`V3 Signer Server active on port ${PORT}`));