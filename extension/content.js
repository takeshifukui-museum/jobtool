// Museum JobTool - Content Script
// This script is injected into job posting pages (HRMOS, etc.)

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getPageContent") {
    // Get the page content
    const content = {
      url: window.location.href,
      title: document.title,
      html: document.body.innerHTML,
      text: document.body.innerText,
    };
    sendResponse(content);
  }
  return true;
});

// Log that the content script is loaded (for debugging)
console.log("Museum JobTool content script loaded on:", window.location.href);
