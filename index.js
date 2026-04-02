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
        let { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        const cleanUser = ethers.getAddress(userAddress);
        const cleanFrom = ethers.getAddress(fromToken);
        const cleanTo = ethers.getAddress(toToken);

        console.log(`--- Request Start for Nonce: ${nonce} ---`);

        // 1. 必須データの取得
        const [isFromOk, isToOk, fromRate, toRate] = await Promise.all([
            retryCall(() => contract.isSupported(cleanFrom), "isFromSupported"),
            retryCall(() => contract.isSupported(cleanTo), "isToSupported"),
            retryCall(() => contract.tokenRates(cleanFrom), "fromRate"),
            retryCall(() => contract.tokenRates(cleanTo), "toRate")
        ]);

        // 2. 上限額の取得
        let maxLimitUSD;
        try {
            maxLimitUSD = await contract.maxSwapAmountUSD();
        } catch (e) {
            console.log(`Warning: Could not fetch maxSwapAmountUSD, using default 100 USD.`);
            maxLimitUSD = ethers.parseUnits("100", 18);
        }

        // バリデーション
        if (!isFromOk || !isToOk || fromRate === 0n || toRate === 0n) {
            return res.status(400).json({ error: "Unsupported token or rate not set" });
        }

        const fromAmountBI = BigInt(fromAmount);

        // 3. 上限チェック (USD換算)
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(10 ** 18);
        if (fromAmountUSD > maxLimitUSD) {
            console.log(`Limit Exceeded: ${fromAmountUSD} > ${maxLimitUSD}`);
            return res.status(400).json({ error: "Exceeds max swap amount" });
        }

        // 4. スワップ後の数量（払出額）計算
        const toAmountBI = (fromAmountBI * fromRate) / toRate;

        // 【新規追加】5. 在庫チェックロジック
        // 署名を発行する直前に、プールの残高が足りているか厳密にチェックします
        const actualStock = await retryCall(() => contract.getStock(cleanTo), "getStock");
        if (actualStock < toAmountBI) {
            console.log(`Insufficient Stock: Required ${toAmountBI} > Available ${actualStock}`);
            return res.status(400).json({
                error: "Insufficient liquidity",
                message: "プールの在庫が不足しています。管理者に補充を依頼してください。"
            });
        }

        // 6. 署名ハッシュ作成 (Solidity V4準拠)
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [cleanUser, cleanFrom, cleanTo, fromAmountBI, toAmountBI, BigInt(nonce)]
        );

        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        console.log(`Success: Signature generated for Nonce ${nonce}`);

        res.json({
            toAmount: toAmountBI.toString(),
            signature: signature
        });

    } catch (error) {
        console.error("Critical Server Error:", error);
        res.status(500).json({ error: "Internal Server Error", message: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Signer V4 Active | Target: ${CONTRACT_ADDRESS}`);
});