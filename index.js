// 1. TLS/SSLの証明書検証を無効化（Robinhoodテストネット接続には必須）
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
const RPC_URL = "https://rpc-testnet.robinhoodchain.com";

// 2. プロバイダー設定：staticNetworkで接続時のオーバーヘッドを削減
const provider = new ethers.JsonRpcProvider(RPC_URL, 8008135, {
    staticNetwork: true
});

// PRIVATE_KEYの取得と補完
let privateKey = process.env.PRIVATE_KEY;
if (privateKey && !privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey;
}

// ウォレットの初期化
const wallet = new ethers.Wallet(privateKey, provider);

const ABI = [
    "function tokenRates(address) view returns (uint256)",
    "function maxSwapAmountUSD() view returns (uint256)",
    "function isSupported(address) view returns (bool)"
];

// コントラクトインスタンスの作成
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

app.post('/get-signature', async (req, res) => {
    try {
        const { userAddress, fromToken, toToken, fromAmount, nonce } = req.body;

        console.log(`[DEBUG] Request received for: ${userAddress}`);

        // 通信の安定性を高めるため、個別に await 実行
        // ここでエラーが出る場合は RPC URL または ネットワーク負荷が原因です
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

        // 上限チェック機能（保持）
        if (fromAmountUSD > maxLimitUSD) {
            return res.status(400).json({
                error: "Exceeds max swap amount limit (USD)",
                requestedUSD: ethers.formatUnits(fromAmountUSD, 18),
                limitUSD: ethers.formatUnits(maxLimitUSD, 18)
            });
        }

        if (toRate === BigInt(0)) {
            return res.status(400).json({ error: "Target token rate is zero." });
        }

        const toAmountBN = (fromAmountBN * fromRate) / toRate;
        const toAmount = toAmountBN.toString();

        // 署名作成ロジック（保持）
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint256"],
            [userAddress, fromToken, toToken, fromAmount, toAmount, nonce]
        );

        const signature = await wallet.signMessage(ethers.toBeArray(messageHash));

        console.log(`[DEBUG] Signature generated successfully`);

        res.json({
            toAmount,
            signature,
            rateUsed: ethers.formatUnits(fromRate, 18)
        });

    } catch (error) {
        // Renderのログで詳細を確認できるように詳細を出力
        console.error("Signature Error Details:", error);
        res.status(500).json({
            error: "Internal server error during signing.",
            details: error.message,
            code: error.code // EPROTO 等のエラーコードを表示
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`V3 Signer Server active on port ${PORT}`);
    console.log(`Configured for Robinhood Testnet (ChainID: 8008135)`);
});