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

const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });

let pk = PRIVATE_KEY;
if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
const wallet = new ethers.Wallet(pk, provider);

// 【修正箇所】ABIをマッピングのゲッター仕様に厳密に定義
const ABI = [
    "function tokenRates(address token) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address token) view returns (bool)"
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

        // アドレスの正規化 (Checksum変換)
        const cleanUser = ethers.getAddress(userAddress);
        const cleanFrom = ethers.getAddress(fromToken);
        const cleanTo = ethers.getAddress(toToken);

        console.log(`--- Request Start ---`);
        console.log(`Contract: ${CONTRACT_ADDRESS}`);
        console.log(`From: ${cleanFrom} | To: ${cleanTo}`);

        // データ取得
        const [fromRate, toRate, maxLimitUSD, isFromOk, isToOk] = await Promise.all([
            retryCall(() => contract.tokenRates(cleanFrom), "fromRate"),
            retryCall(() => contract.tokenRates(cleanTo), "toRate"),
            retryCall(() => contract.maxSwapAmountUSD(), "maxLimit"),
            retryCall(() => contract.isSupported(cleanFrom), "isFromOk"),
            retryCall(() => contract.isSupported(cleanTo), "isToOk")
        ]);

        console.log(`Status -> fromOk:${isFromOk}, toOk:${isToOk}, rate:${fromRate.toString()}`);

        if (!isFromOk || !isToOk || fromRate === 0n || toRate === 0n) {
            return res.status(400).json({
                error: "Unsupported token or rate not set",
                debug: { isFromOk, isToOk, fromRate: fromRate.toString(), toRate: toRate.toString() }
            });
        }

        const fromAmountBI = BigInt(fromAmount);

        // 【既存機能】上限チェック
        const fromAmountUSD = (fromAmountBI * fromRate) / BigInt(10 ** 18);
        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({ error: "Exceeds max swap amount" });
        }

        const toAmountBI = (fromAmountBI * fromRate) / toRate;

        // 署名ハッシュ作成 (Solidity V3準拠)
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [cleanUser, cleanFrom, cleanTo, fromAmountBI, toAmountBI, BigInt(nonce)]
        );

        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        res.json({ toAmount: toAmountBI.toString(), signature });

    } catch (error) {
        console.error("Critical Error:", error);
        res.status(500).json({ error: "Server Error", details: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Signer Active | Target: ${CONTRACT_ADDRESS}`);
});