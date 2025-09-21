const API_BASE_URL = 'http://localhost:3000/analyze';

const getAnalysisForText = async (text) => {
    try {
        const response = await fetch(API_BASE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `Server responded with status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error('API Error in background script:', error);
        return {
            overall: "error",
            flags: [{
                title: "Analysis Failed",
                reasons: ["Could not connect to the MisinfoShield analysis server.", error.message]
            }]
        };
    }
}

const openPopupWithText = (text) => {
    chrome.storage.local.set({ textToScan: text }, () => {
        chrome.windows.create({
            url: 'popup.html',
            type: 'popup',
            width: 410,
            height: 550
        }, (newWindow) => {
            if (chrome.runtime.lastError) {
                console.error("Could not create popup window:", chrome.runtime.lastError.message);
            }
        });
    });
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "openPopupAndScanText" && request.text) {
        openPopupWithText(request.text);
    }
    return true;
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "scanSelectedTextWithBeacon",
        title: "Analyze selection with The Beacon",
        contexts: ["selection"]
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "scanSelectedTextWithBeacon" && info.selectionText) {
        openPopupWithText(info.selectionText);
    }
});
