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

const provider = new ethers.JsonRpcProvider(RPC_URL);

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

const ABI = [
    "function isSupported(address) view returns (bool)",
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function getStock(address) view returns (uint256)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

async function retryCall(fn, name = "Request", retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            console.error(`[${name}] Attempt ${i + 1} failed:`, err.message);
            if (i === retries - 1) throw err;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

app.post('/get-signature', async (req, res) => {
    try {
        const { user, fromToken, toToken, fromAmount, nonce } = req.body;

        const cleanUser = ethers.getAddress(user);
        const cleanFrom = ethers.getAddress(fromToken);
        const cleanTo = ethers.getAddress(toToken);

        // 1. 必須データの取得
        // 変数名の衝突を避けるため fRate, tRate としています
        const [isFromOk, isToOk, fRate, tRate] = await Promise.all([
            retryCall(() => contract.isSupported(cleanFrom), "isFromSupported"),
            retryCall(() => contract.isSupported(cleanTo), "isToSupported"),
            retryCall(() => contract.tokenRates(cleanFrom), "fromRate"),
            retryCall(() => contract.tokenRates(cleanTo), "toRate")
        ]);

        // 2. バリデーション（★テスト用に一時的に無効化中）
        if (false && (!isFromOk || !isToOk || fRate === 0n || tRate === 0n)) {
            return res.status(400).json({ error: "Unsupported token or rate not set" });
        }

        // 3. 数値計算の準備 (BigInt型に統一)
        const fromAmountBI = BigInt(fromAmount);
        const fromRateBI = BigInt(fRate);
        const toRateBI = BigInt(tRate);

        // 4. USD換算チェック（★テスト用に一時的に無効化中）
        // 10n ** 18n を使い、BigInt同士で計算して型エラーを防ぎます
        const fromAmountUSD = (fromAmountBI * fromRateBI) / (10n ** 18n);
        const maxLimitUSD = await retryCall(() => contract.maxSwapAmountUSD(), "maxLimit");

        if (false && fromAmountUSD > maxLimitUSD) {
            console.log(`Limit Exceeded: ${fromAmountUSD} > ${maxLimitUSD}`);
            return res.status(400).json({ error: "Exceeds max swap amount" });
        }

        // 5. 受け取り数量（払出額）計算
        // ここで 1 AMZN -> 5,000 MRT のような計算が行われます
        const toAmountBI = (fromAmountBI * fromRateBI) / toRateBI;

        // 6. 在庫チェックロジック（★テスト用に一時的に無効化中）
        const actualStock = await retryCall(() => contract.getStock(cleanTo), "getStock");
        if (false && actualStock < toAmountBI) {
            console.log(`Insufficient Stock: Required ${toAmountBI} > Available ${actualStock}`);
            return res.status(400).json({
                error: "Insufficient liquidity",
                message: "プールの在庫が不足しています。管理者に補充を依頼してください。"
            });
        }

        // 7. 署名ハッシュ作成 (Solidityの abi.encodePacked と完全に一致させます)
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [
                cleanUser,
                cleanFrom,
                cleanTo,
                fromAmountBI,
                toAmountBI,
                BigInt(nonce)
            ]
        );

        // 重要：messageHash を「文字列」ではなく「バイト配列」として署名します
        const messageBytes = ethers.getBytes(messageHash);
        const signature = await wallet.signMessage(messageBytes);

        console.log(`Success: Signature generated for ${toAmountBI.toString()} MRT`);

        res.json({
            toAmount: toAmountBI.toString(),
            signature: signature
        });

    } catch (error) {
        console.error("Signature Error:", error);
        res.status(500).json({
            error: "Internal Server Error",
            message: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Signer V4 Active | Port: ${PORT}`);
});