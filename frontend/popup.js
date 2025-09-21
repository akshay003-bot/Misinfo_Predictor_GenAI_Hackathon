document.addEventListener('DOMContentLoaded', () => {
  const analyzeButton = document.getElementById('analyzeButton');
  const phishingButton = document.getElementById('phishingButton');
  const linksButton = document.getElementById('linksButton');
  const statusDiv = document.getElementById('status');
  const resultsDiv = document.getElementById('results');
  const credibilityMeter = document.getElementById('credibility-meter');
  const credibilityText = document.getElementById('credibility-text');
  const credibilityBar = document.getElementById('credibility-bar');

  chrome.storage.local.get(['textToScan'], (result) => {
    if (result.textToScan) {
      performScanWithText(result.textToScan, 'http://localhost:3000/analyze', 'Fact-Checking Selected Text...');
      chrome.storage.local.remove('textToScan');
    }
  });

  analyzeButton.addEventListener('click', () => {
    performTextScan('http://localhost:3000/analyze', 'Fact-Checking Page Content...');
  });

  phishingButton.addEventListener('click', () => {
    performTextScan('http://localhost:3000/detect-phishing', 'Running AI Content Scan...');
  });

  linksButton.addEventListener('click', async () => {
    statusDiv.textContent = 'Scanning all links on page...';
    statusDiv.className = 'status-bar scanning';
    resultsDiv.innerHTML = '';
    credibilityMeter.style.display = 'none';
    disableButtons(true);

    try {
        const urls = await getPageLinks();
        if (!urls || urls.length === 0) {
            throw new Error("No scannable web links (http/https) were found on this page.");
        }
        const response = await fetch('http://localhost:3000/check-urls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls }),
        });
        if (!response.ok) throw new Error(`Server returned status: ${response.status}`);
        const analysis = await response.json();
        displayResults(analysis);
    } catch (error) {
        console.error('Link Scan Error:', error);
        displayResults({ overall: "error", flags: [{ title: "Link Scan Failed", reasons: [error.message] }] });
    } finally {
        disableButtons(false);
    }
  });

  async function performTextScan(endpoint, statusMessage) {
    const pageText = await getPageText();
    await performScanWithText(pageText, endpoint, statusMessage);
  }
  
  async function performScanWithText(text, endpoint, statusMessage) {
    statusDiv.textContent = statusMessage;
    statusDiv.className = 'status-bar scanning';
    resultsDiv.innerHTML = '';
    credibilityMeter.style.display = 'none';
    disableButtons(true);
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error(`Server returned status: ${response.status}`);
        const analysis = await response.json();
        displayResults(analysis);
    } catch(error) {
        console.error('Scan Error:', error);
        displayResults({ overall: "error", flags: [{ title: "Scan Failed", reasons: [error.message] }] });
    } finally {
        disableButtons(false);
    }
  }

  async function getPageLinks() {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injectionResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
            const allLinks = Array.from(document.querySelectorAll('a')).map(a => a.href);
            const webLinks = allLinks.filter(href => href && (href.startsWith('http://') || href.startsWith('https://')));
            return Array.from(new Set(webLinks));
        },
    });
    return injectionResult ? injectionResult.result : [];
  }

  async function getPageText() {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => document.body.innerText,
    });
    return injectionResult ? injectionResult.result : '';
  }

  function disableButtons(disabled) {
      analyzeButton.disabled = disabled;
      phishingButton.disabled = disabled;
      linksButton.disabled = disabled;
  }

  function displayResults(analysis) {
    resultsDiv.innerHTML = '';
    if (analysis.credibility) {
      credibilityMeter.style.display = 'block';
      const { score, label } = analysis.credibility;
      credibilityText.textContent = `${label} (${score}%)`;
      credibilityBar.style.width = `${score}%`;
      credibilityBar.className = 'credibility-bar';
      credibilityBar.classList.add(`credibility-${label.toLowerCase().replace(' ', '-')}`);
    } else {
      credibilityMeter.style.display = 'none';
    }
    
    switch (analysis.overall) {
      case "risk": statusDiv.textContent = "⚠️ Risk Detected: Review findings."; statusDiv.className = 'status-bar risk'; break;
      case "clean": statusDiv.textContent = "✅ No major threats found."; statusDiv.className = 'status-bar clean'; break;
      default: statusDiv.textContent = "❌ Error: Scan could not be completed."; statusDiv.className = 'status-bar risk';
    }

    if (analysis.flags && analysis.flags.length > 0) {
      analysis.flags.forEach(flag => {
        const card = document.createElement('div');
        card.className = 'result-card warning';
        card.innerHTML = `
            <div class="result-header"><span>${flag.title}</span><span class="result-type info">Finding</span></div>
            <div class="reasons"><ul>${flag.reasons.map(r => `<li>${r}</li>`).join('')}</ul></div>`;
        resultsDiv.appendChild(card);
      });
    }
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "displayAnalysisResult") displayResults(request.result);
  });
});