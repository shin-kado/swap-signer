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
const RPC_URL = process.env.RPC_URL_ROBINHOOD;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ネットワーク情報を手動で定義して、自動検知を完全に封じ込めます
const networkInfo = {
    chainId: 8008135, // Robinhood TestnetのID
    name: 'robinhood-testnet'
};

const provider = new ethers.JsonRpcProvider(RPC_URL, networkInfo, {
    staticNetwork: true
});

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        const [fromRate, toRate, maxLimitUSD, isFromOk, isToOk] = await Promise.all([
            contract.tokenRates(fromToken),
            contract.tokenRates(toToken),
            contract.maxSwapAmountUSD(),
            contract.isSupported(fromToken),
            contract.isSupported(toToken)
        ]);

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

        res.json({
            toAmount,
            signature,
            rateUsed: ethers.formatUnits(fromRate, 18)
        });

    } catch (error) {
        console.error("Signature Error:", error);
        res.status(500).json({ error: "Internal server error during signing." });
    }
});

const PORT = process.env.PORT || 10000; // Renderのデフォルト10000に合わせておきます
app.listen(PORT, () => console.log(`V3 Signer Server active on port ${PORT}`));