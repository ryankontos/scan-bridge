property targetUrlPrefix : "https://scan.ryankontos.com/"
property pollIntervalSeconds : 0.35
property lastSeenScanId : ""
property lastCopiedValue : ""

on run
	my ensureChromeObserverTab()
	repeat
		try
			set observerTab to my findObserverTab()
			if observerTab is missing value then
				set observerTab to my ensureChromeObserverTab()
			end if
			
			set jsSource to my observerJavaScript()
			tell application "Google Chrome"
				set payload to execute javascript jsSource in observerTab
			end tell
			
			if payload is not missing value then
				set payloadLines to paragraphs of payload
				if (count of payloadLines) >= 5 then
					if item 1 of payloadLines is "__SCAN_BRIDGE__" then
						set currentScanId to item 2 of payloadLines
						set currentExtractedValue to item 3 of payloadLines
						
						if currentExtractedValue is not "" then
							if currentScanId is not lastSeenScanId or currentExtractedValue is not lastCopiedValue then
								set the clipboard to currentExtractedValue
								set lastSeenScanId to currentScanId
								set lastCopiedValue to currentExtractedValue
							end if
						end if
					end if
				end if
			end if
		on error
			set lastSeenScanId to ""
		end try
		
		delay pollIntervalSeconds
	end repeat
end run

on observerJavaScript()
	return "(function () { var raw = window.__scanBridgeObserver || JSON.parse(localStorage.getItem('scan-bridge-observer') || 'null'); if (!raw) { return '__SCAN_BRIDGE__\\n\\n\\n\\n'; } var clean = function (value) { return String(value || '').replace(/[\\r\\n]+/g, ' ').trim(); }; return ['__SCAN_BRIDGE__', clean(raw.latestScanId), clean(raw.latestExtracted), clean(raw.regexPresetId), clean(raw.sessionId)].join('\\n'); })();"
end observerJavaScript

on findObserverTab()
	tell application "Google Chrome"
		repeat with aWindow in windows
			repeat with aTab in tabs of aWindow
				set tabUrl to URL of aTab
				if tabUrl starts with targetUrlPrefix and tabUrl does not contain "/capture/" then
					return aTab
				end if
			end repeat
		end repeat
	end tell
	
	return missing value
end findObserverTab

on ensureChromeObserverTab()
	tell application "Google Chrome"
		if not running then launch
	end tell
	
	set existingTab to my findObserverTab()
	if existingTab is not missing value then return existingTab
	
	tell application "Google Chrome"
		if (count of windows) is 0 then
			make new window
			set observerTab to active tab of front window
			set URL of observerTab to targetUrlPrefix
			return observerTab
		end if
		
		set originalTabIndex to active tab index of front window
		tell front window
			make new tab with properties {URL:targetUrlPrefix}
			set observerTab to active tab
			set active tab index to originalTabIndex
		end tell
		
		return observerTab
	end tell
end ensureChromeObserverTab
