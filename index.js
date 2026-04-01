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
const RPC_URL = process.env.RPC_URL_ROBINHOOD || "https://rpc.testnet.chain.robinhood.com";

// 検証のため、オプションを外したシンプルなProvider
const provider = new ethers.JsonRpcProvider(RPC_URL);

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

// 最も標準的なABI記述に変更
const ABI = [
    "function isSupported(address) view returns (bool)",
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;
        const cleanFrom = ethers.getAddress(fromToken);
        const cleanTo = ethers.getAddress(toToken);

        console.log(`--- Debug Call Start ---`);
        console.log(`Target: ${CONTRACT_ADDRESS}`);

        // 一括取得せず、1つずつ実行してどこでRevertするか特定する
        let isFromOk = false;
        try {
            isFromOk = await contract.isSupported(cleanFrom);
            console.log(`1. isSupported(From) Success: ${isFromOk}`);
        } catch (e) {
            console.log(`1. isSupported(From) Failed: ${e.message}`);
        }

        let fromRate = 0n;
        try {
            fromRate = await contract.tokenRates(cleanFrom);
            console.log(`2. tokenRates(From) Success: ${fromRate}`);
        } catch (e) {
            console.log(`2. tokenRates(From) Failed: ${e.message}`);
        }

        let maxUSD = 0n;
        try {
            maxUSD = await contract.maxSwapAmountUSD();
            console.log(`3. maxSwapAmountUSD Success: ${maxUSD}`);
        } catch (e) {
            console.log(`3. maxSwapAmountUSD Failed: ${e.message}`);
        }

        // ここから下は署名ロジック（既存機能を維持）
        if (!isFromOk || fromRate === 0n) {
            return res.status(400).json({ error: "Validation failed in debug mode" });
        }

        const fromAmountBI = BigInt(fromAmount);
        const toAmountBI = (fromAmountBI * fromRate) / fromRate; // テスト用計算

        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [ethers.getAddress(userAddress), cleanFrom, cleanTo, fromAmountBI, toAmountBI, BigInt(nonce)]
        );

        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));
        res.json({ toAmount: toAmountBI.toString(), signature });

    } catch (error) {
        console.error("Critical Debug Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Debug Mode Active`));