require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { WebRiskServiceClient } = require('@google-cloud/web-risk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

const FACT_CHECK_API_KEY = process.env.FACT_CHECK_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY || !FACT_CHECK_API_KEY) {
    console.error("CRITICAL ERROR: API keys are not configured in the .env file.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const webRiskClient = new WebRiskServiceClient();
const generativeModel = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ]
});

const getCredibilityLabel = (score) => {
    if (score >= 90) return "Excellent";
    if (score >= 70) return "High";
    if (score >= 40) return "Medium";
    if (score >= 20) return "Low";
    return "Very Low";
};

const cleanJsonString = (rawString) => {
    if (!rawString || typeof rawString !== 'string') return null;
    const match = rawString.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return match ? match[0] : null;
};

const handleApiError = (res, error, context) => {
    console.error(`[ERROR] in ${context}:`, error);
    let userMessage = 'An unexpected error occurred during the analysis. Please try again later.';
    if (error.response) {
        userMessage = `The analysis service returned an error: ${error.response.status}.`;
    } else if (error.request) {
        userMessage = 'Could not connect to the analysis service. Please check your connection.';
    }
    return res.status(500).json({
        overall: "error",
        flags: [{ title: "Analysis Failed", reasons: [userMessage, `Context: ${context}`] }]
    });
};

app.post('/analyze', async (req, res) => {
    const { text } = req.body;
    if (!text || text.length < 50) {
        return res.status(200).json({
            overall: "clean",
            flags: [{ title: "Content Too Short", reasons: ["The provided text is too short for a meaningful analysis."] }],
            credibility: { score: 75, label: "Medium" }
        });
    }

    try {
        const fullAnalysisPrompt = `
            Analyze the following text comprehensively for misinformation, bias, and manipulation.
            Return a single, valid JSON object with the following structure:
            {
              "claims": ["Extract up to 2 specific, verifiable claims.", "If none, return an empty array."],
              "biasAnalysis": {
                "score": "A credibility score from 0 (very low) to 100 (very high) based on language and tone.",
                "explanation": "A one-sentence explanation for the score.",
                "signals": ["List up to 3 specific signals of bias or manipulation found (e.g., 'Loaded Language', 'Appeal to Emotion', 'Us-vs-Them Mentality'). If none, return an empty array."]
              }
            }
            Text: "${text.substring(0, 4000)}"`;

        const analysisResult = await generativeModel.generateContent(fullAnalysisPrompt);
        const analysisResponse = analysisResult.response;
        const initialAnalysis = JSON.parse(cleanJsonString(analysisResponse.text()));

        if (!initialAnalysis) {
             throw new Error("Failed to parse initial analysis from the AI model.");
        }

        const { claims, biasAnalysis } = initialAnalysis;
        let flags = [];
        let finalScore = biasAnalysis.score || 75;
        let riskDetected = false;

        if (biasAnalysis.signals && biasAnalysis.signals.length > 0) {
            flags.push({
                title: "Propaganda & Bias Signals",
                reasons: biasAnalysis.signals
            });
            finalScore = Math.min(finalScore, 40);
            riskDetected = true;
        } else {
             flags.push({
                title: "AI Credibility Analysis",
                reasons: [biasAnalysis.explanation || "The text appears neutral in tone."]
            });
        }


        if (claims && claims.length > 0) {
            for (const claim of claims) {
                const dbSearchUrl = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(claim)}&key=${FACT_CHECK_API_KEY}`;
                const { data } = await axios.get(dbSearchUrl);

                if (data.claims && data.claims.length > 0) {
                    const review = data.claims[0].claimReview[0];
                    const rating = review.textualRating.toLowerCase();
                    let scoreUpdate = 30;
                    if (rating.includes("false") || rating.includes("distorted")) scoreUpdate = 5;
                    if (rating.includes("misleading")) scoreUpdate = 20;

                    finalScore = Math.min(finalScore, scoreUpdate);
                    riskDetected = true;
                    flags.push({
                        title: `Fact-Check: Rated "${review.textualRating}"`,
                        reasons: [`Claim: "${claim}"`, `Publisher: ${review.publisher.name}`]
                    });
                    continue;
                }

                const aiFactCheckPrompt = `Is the following claim true, false, or unproven based on reliable web sources? Provide a brief explanation. Respond ONLY with a valid JSON object like {"verdict": "True/False/Unproven", "explanation": "string"}. Claim: "${claim}"`;
                const aiFactCheckResult = await generativeModel.generateContent(aiFactCheckPrompt);
                const aiCheck = JSON.parse(cleanJsonString(aiFactCheckResult.response.text()));

                if (aiCheck && aiCheck.verdict.toLowerCase() === 'false') {
                    finalScore = Math.min(finalScore, 15);
                    riskDetected = true;
                    flags.push({
                        title: `AI Fact-Check: Likely False`,
                        reasons: [`Claim: "${claim}"`, `Reasoning: ${aiCheck.explanation}`]
                    });
                }
            }
        }
        
        return res.status(200).json({
            overall: riskDetected || finalScore < 50 ? "risk" : "clean",
            flags,
            credibility: { score: finalScore, label: getCredibilityLabel(finalScore) }
        });

    } catch (error) {
        return handleApiError(res, error, 'Content Analysis');
    }
});

app.post('/detect-phishing', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required for AI analysis.' });

    try {
        const prompt = `Analyze the text for phishing signals like urgency, threats, suspicious links, or requests for sensitive information. Provide a risk score from 0 (none) to 10 (blatant phishing) and a brief explanation. Respond ONLY with a valid JSON object: {"riskScore": number, "explanation": "string"}. Text: "${text}"`;
        const result = await generativeModel.generateContent(prompt);
        const aiAnalysis = JSON.parse(cleanJsonString(result.response.text()));

        if (!aiAnalysis) {
             throw new Error("Failed to parse phishing analysis from the AI model.");
        }

        const score = 100 - (aiAnalysis.riskScore * 10);
        const overall = score < 40 ? "risk" : "clean";

        res.status(200).json({
            overall,
            flags: [{ title: `AI Phishing Scan (Risk: ${aiAnalysis.riskScore}/10)`, reasons: [aiAnalysis.explanation] }],
            credibility: { score, label: getCredibilityLabel(score) }
        });
    } catch (error) {
        return handleApiError(res, error, 'Phishing Detection');
    }
});

app.post('/check-urls', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: 'An array of URLs is required.' });
    }

    const webUrls = [...new Set(urls.filter(url => typeof url === 'string' && (url.trim().toLowerCase().startsWith('http://') || url.trim().toLowerCase().startsWith('https://'))))];

    if (webUrls.length === 0) {
        return res.status(200).json({
            overall: "clean",
            flags: [{ title: "No Web Links Found", reasons: ["No scannable web URLs were found on this page."] }],
            credibility: { score: 100, label: "Excellent" }
        });
    }

    try {
        const requests = webUrls.map(url => webRiskClient.searchUris({
            uri: url,
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
        }));
        const results = await Promise.all(requests);
        
        const flaggedUrls = results.reduce((acc, [response], index) => {
            const { threat } = response;
            if (threat && threat.threatTypes && threat.threatTypes.length > 0) {
                acc.push({
                    url: webUrls[index],
                    threats: threat.threatTypes.join(', ')
                });
            }
            return acc;
        }, []);

        const score = flaggedUrls.length > 0 ? 0 : 100;
        const overall = score < 100 ? "risk" : "clean";
        const flags = overall === "risk"
            ? flaggedUrls.map(item => ({ title: `Malicious URL Detected`, reasons: [`URL: ${item.url}`, `Threat Type: ${item.threats}`] }))
            : [{ title: "All Links Appear Safe", reasons: [`Google Web Risk scanned ${webUrls.length} unique link(s) and found no threats.`] }];

        res.status(200).json({ overall, flags, credibility: { score, label: getCredibilityLabel(score) } });
    } catch (error) {
        return handleApiError(res, error, 'URL Scanning');
    }
});

app.listen(PORT, () => {
    console.log(`The Beacon Server started...`);
    console.log(`Current time is: ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}.`);
    console.log(`Listening for requests on http://localhost:${PORT}`);
});

