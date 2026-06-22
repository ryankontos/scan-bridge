property targetUrlPrefix : "https://scan.ryankontos.com/"
property pollIntervalSeconds : 0.35
property javascriptRetryCount : 3
property maxIdlePollsBeforeReload : 18
property enableLogging : true
property lastSeenScanId : ""
property lastCopiedValue : ""
property consecutiveFailures : 0
property idlePollCount : 0

on run
	my logMessage("observer start")
	my ensureChromeObserverTab()
	repeat
		try
			set observerTab to my findObserverTab()
			if observerTab is missing value then
				my logMessage("observer tab missing; recreating")
				set observerTab to my ensureChromeObserverTab()
			end if
			
			set payload to my readObserverPayload(observerTab)
			if payload is missing value then
				set idlePollCount to idlePollCount + 1
				if idlePollCount ≥ maxIdlePollsBeforeReload then
					my logMessage("payload idle threshold reached; reloading tab")
					my reloadObserverTab(observerTab)
					set idlePollCount to 0
				end if
			else
				set parsedPayload to my parseObserverPayload(payload)
				if parsedPayload is not missing value then
					set currentScanId to item 1 of parsedPayload
					set currentExtractedValue to item 2 of parsedPayload
					
					set consecutiveFailures to 0
					if currentScanId is not "" or currentExtractedValue is not "" then set idlePollCount to 0
					
					if currentExtractedValue is not "" then
						if currentScanId is not lastSeenScanId or currentExtractedValue is not lastCopiedValue then
							set the clipboard to currentExtractedValue
							set lastSeenScanId to currentScanId
							set lastCopiedValue to currentExtractedValue
							my logMessage("copied scan_id=" & currentScanId & " value=" & currentExtractedValue)
						end if
					end if
				else
					set idlePollCount to idlePollCount + 1
				end if
			end if
		on error errorMessage number errorNumber
			set consecutiveFailures to consecutiveFailures + 1
			my logMessage("loop error #" & errorNumber & " " & errorMessage)
			if consecutiveFailures ≥ 3 then
				try
					my logMessage("failure threshold reached; ensuring observer tab")
					my ensureChromeObserverTab()
				end try
				set consecutiveFailures to 0
			end if
		end try
		
		delay pollIntervalSeconds
	end repeat
end run

on readObserverPayload(observerTab)
	repeat with retryIndex from 1 to javascriptRetryCount
		try
			set jsSource to my observerJavaScript()
			tell application "Google Chrome"
				set payload to execute javascript jsSource in observerTab
			end tell
			
			if payload is not missing value and payload is not "" then
				return payload
			end if
		on error errorMessage number errorNumber
			if retryIndex is javascriptRetryCount then
				my logMessage("javascript read failed after retries #" & errorNumber & " " & errorMessage)
			end if
		end try
		
		delay 0.12
	end repeat
	
	return missing value
end readObserverPayload

on parseObserverPayload(payload)
	try
		set payloadLines to paragraphs of payload
		if (count of payloadLines) < 5 then return missing value
		if item 1 of payloadLines is not "__SCAN_BRIDGE__" then return missing value
		return {item 2 of payloadLines, item 3 of payloadLines, item 4 of payloadLines, item 5 of payloadLines}
	on error
		return missing value
	end try
end parseObserverPayload

on observerJavaScript()
	return "(function () { try { var raw = window.__scanBridgeObserver || JSON.parse(localStorage.getItem('scan-bridge-observer') || 'null'); if (!raw) { return '__SCAN_BRIDGE__\\n\\n\\n\\n'; } var clean = function (value) { return String(value || '').replace(/[\\r\\n]+/g, ' ').trim(); }; var extracted = clean(raw.latestExtracted); if (!extracted) { return '__SCAN_BRIDGE__\\n' + clean(raw.latestScanId) + '\\n\\n' + clean(raw.regexPresetId) + '\\n' + clean(raw.sessionId); } return ['__SCAN_BRIDGE__', clean(raw.latestScanId), extracted, clean(raw.regexPresetId), clean(raw.sessionId)].join('\\n'); } catch (error) { return '__SCAN_BRIDGE__\\n\\n\\n\\n'; } })();"
end observerJavaScript

on findObserverTab()
	tell application "Google Chrome"
		repeat with aWindow in windows
			repeat with aTab in tabs of aWindow
				try
					set tabUrl to URL of aTab
					if tabUrl starts with targetUrlPrefix and tabUrl does not contain "/capture/" then
						return aTab
					end if
				end try
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
	if existingTab is not missing value then
		my logMessage("reusing existing observer tab")
		my waitForObserverTab(existingTab)
		return existingTab
	end if
	
	tell application "Google Chrome"
		if (count of windows) is 0 then
			make new window
			set observerTab to active tab of front window
			set URL of observerTab to targetUrlPrefix
			my logMessage("created observer window")
			my waitForObserverTab(observerTab)
			return observerTab
		end if
		
		set originalTabIndex to active tab index of front window
		tell front window
			make new tab with properties {URL:targetUrlPrefix}
			set observerTab to active tab
			set active tab index to originalTabIndex
		end tell
	end tell
	
	my logMessage("created observer tab")
	my waitForObserverTab(observerTab)
	return observerTab
end ensureChromeObserverTab

on waitForObserverTab(observerTab)
	repeat 20 times
		try
			tell application "Google Chrome"
				set tabUrl to URL of observerTab
				if tabUrl starts with targetUrlPrefix then
					set readyState to execute javascript "document.readyState" in observerTab
					if readyState is "interactive" or readyState is "complete" then return true
				end if
			end tell
		end try
		
		delay 0.2
	end repeat
	
	my logMessage("observer tab did not become ready in time")
	return false
end waitForObserverTab

on reloadObserverTab(observerTab)
	try
		tell application "Google Chrome"
			set URL of observerTab to targetUrlPrefix
		end tell
		my logMessage("reloaded observer tab")
		my waitForObserverTab(observerTab)
	on error errorMessage number errorNumber
		my logMessage("reload failed #" & errorNumber & " " & errorMessage)
		my ensureChromeObserverTab()
	end try
end reloadObserverTab

on logMessage(messageText)
	if enableLogging is false then return
	
	try
		set timestampText to do shell script "date '+%Y-%m-%d %H:%M:%S'"
		log timestampText & " " & messageText
	end try
end logMessage
