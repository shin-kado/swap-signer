process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// Renderの環境変数からURLを取得、なければデフォルトのHTTPSを使用
const RPC_URL = process.env.RPC_URL_ROBINHOOD || "https://rpc.testnet.chain.robinhood.com";

const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    staticNetwork: true
});

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

async function retryCall(fn, name = "Request", retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            console.log(`[Retry] ${name} failed: ${err.message}`);
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        // 1. コントラクトから状態を取得
        const [fromRate, toRate, maxLimitUSD, isFromOk, isToOk] = await Promise.all([
            retryCall(() => contract.tokenRates(fromToken), "fromRate"),
            retryCall(() => contract.tokenRates(toToken), "toRate"),
            retryCall(() => contract.maxSwapAmountUSD(), "maxLimit"),
            retryCall(() => contract.isSupported(fromToken), "isFromOk"),
            retryCall(() => contract.isSupported(toToken), "isToOk")
        ]);

        // 2. バリデーション
        if (!isFromOk || !isToOk || fromRate === 0n || toRate === 0n) {
            return res.status(400).json({ error: "Unsupported token or rate not set" });
        }

        const fromAmountBI = BigInt(fromAmount);
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(10 ** 18);

        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({ error: "Exceeds max swap amount" });
        }

        const toAmountBI = (fromAmountBI * fromRate) / toRate;

        // 3. Solidity v0.8.20 (V3) 仕様の署名作成
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [
                ethers.getAddress(userAddress),
                ethers.getAddress(fromToken),
                ethers.getAddress(toToken),
                fromAmountBI,
                toAmountBI,
                BigInt(nonce)
            ]
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`V3 Signer Active on port ${PORT}`);
    console.log(`Target Contract: ${CONTRACT_ADDRESS}`);
    console.log(`Using RPC: ${RPC_URL}`);
});