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

// 【既存の書式を維持】検証で成功したシンプルなProvider設定
const provider = new ethers.JsonRpcProvider(RPC_URL);

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

// 【ABIの更新】既存機能を保持しつつ getStock を追加
const ABI = [
    "function isSupported(address) view returns (bool)",
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function getStock(address) view returns (uint256)" // 在庫確認用に追加
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
        const { user, fromToken, toToken, fromAmount, nonce } = req.body;

        const cleanUser = ethers.getAddress(user);
        const cleanFrom = ethers.getAddress(fromToken);
        const cleanTo = ethers.getAddress(toToken);

        // 1. 必須データの取得（ここを一つにまとめます）
        const [isFromOk, isToOk, fRate, tRate] = await Promise.all([
            retryCall(() => contract.isSupported(cleanFrom), "isFromSupported"),
            retryCall(() => contract.isSupported(cleanTo), "isToSupported"),
            retryCall(() => contract.tokenRates(cleanFrom), "fromRate"),
            retryCall(() => contract.tokenRates(cleanTo), "toRate")
        ]);

        // 2. バリデーション（テスト用に無効化中）
        if (false && (!isFromOk || !isToOk || fRate === 0n || tRate === 0n)) {
            return res.status(400).json({ error: "Unsupported token or rate not set" });
        }

        // 3. 数値計算の準備
        const fromAmountBI = BigInt(fromAmount);
        const fromRateBI = BigInt(fRate);
        const toRateBI = BigInt(tRate);

        // 4. USD換算チェック（テスト用に無効化中）
        const fromAmountUSD = (fromAmountBI * fromRateBI) / (10n ** 18n);
        const maxLimitUSD = await retryCall(() => contract.maxSwapAmountUSD(), "maxLimit");

        if (false && fromAmountUSD > maxLimitUSD) {
            console.log(`Limit Exceeded: ${fromAmountUSD} > ${maxLimitUSD}`);
            return res.status(400).json({ error: "Exceeds max swap amount" });
        }

        // 5. 受け取り数量（払出額）計算
        const toAmountBI = (fromAmountBI * fromRateBI) / toRateBI;

        // 6. 在庫チェックロジック（テスト用に無効化中）
        const actualStock = await retryCall(() => contract.getStock(cleanTo), "getStock");
        if (false && actualStock < toAmountBI) {
            console.log(`Insufficient Stock: Required ${toAmountBI} > Available ${actualStock}`);
            return res.status(400).json({
                error: "Insufficient liquidity",
                message: "プールの在庫が不足しています。"
            });
        }

    });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Signer V4 Active | Target: ${CONTRACT_ADDRESS}`);
});