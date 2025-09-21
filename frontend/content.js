(() => {
    let scanButton;

    const createScanButton = () => {
        scanButton = document.createElement('button');
        scanButton.id = 'beacon-scan-selection-button';
        scanButton.innerText = 'Analyze with The Beacon';
        document.body.appendChild(scanButton);

        scanButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const selectedText = window.getSelection().toString().trim();
            if (selectedText) {
                try {
                    chrome.runtime.sendMessage({
                        action: "openPopupAndScanText",
                        text: selectedText
                    });
                } catch (error) {
                    if (error.message.includes("Extension context invalidated")) {
                        alert("The Beacon extension was updated. Please reload this page to continue.");
                    } else {
                        console.error("An unexpected error occurred:", error);
                    }
                }
            }
            hideButton();
        });
    }

    const hideButton = () => {
        if (scanButton) {
            scanButton.style.display = 'none';
        }
    };

    const showButton = () => {
        if (!scanButton) createScanButton();

        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        if (selectedText.length > 20 && selectedText.length < 5000) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            scanButton.style.display = 'block';
            scanButton.style.top = `${rect.bottom + window.scrollY + 6}px`;
            scanButton.style.left = `${rect.left + window.scrollX + (rect.width / 2) - (scanButton.offsetWidth / 2)}px`;
        } else {
            hideButton();
        }
    };
    
    let debounceTimer;
    document.addEventListener('selectionchange', () => {
        clearTimeout(debounceTimer);
        const selection = window.getSelection();
        if(!selection.isCollapsed) {
            debounceTimer = setTimeout(showButton, 200);
        } else {
             hideButton();
        }
    });

    document.addEventListener('click', hideButton);
})();
