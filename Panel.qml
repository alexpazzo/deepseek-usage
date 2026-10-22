import QtQuick
import QtQuick.Controls
import QtQuick.Effects
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Usage.js" as Usage
import "Pricing.js" as Pricing

// DeepSeek Usage bar widget: today's spend in the bar, usage/cost breakdown in
// the panel. Two undocumented platform calls (amount + cost) feed Usage.js; the
// optional balance call uses the official API key.
Panel {
  id: root

  ipcTarget: moduleName
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.7)
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false

  // --- settings and paths -------------------------------------------------

  readonly property string pluginDir: {
    var value = String(Qt.resolvedUrl("."))
    if (value.indexOf("file://") === 0) value = value.substring(7)
    try {
      return decodeURIComponent(value).replace(/\/$/, "")
    } catch (e) {
      return value
    }
  }

  readonly property string home: Quickshell.env("HOME")

  function resolvePath(value, fallback) {
    var text = String(value === undefined || value === null ? "" : value).trim()
    if (text === "") return fallback
    if (text === "~") return home
    if (text.indexOf("~/") === 0) return home + text.substring(1)
    return text
  }

  readonly property string tokenPath: resolvePath(String(setting("tokenFile", "")),
    (Quickshell.env("XDG_CONFIG_HOME") || home + "/.config") + "/omarchy/deepseek-usage/token")
  readonly property string tokenCommand: String(setting("tokenCommand", ""))
  readonly property string apiKeyPath: resolvePath(String(setting("apiKeyFile", "")), "")
  readonly property string endpointBase: String(setting("endpointBase", "https://platform.deepseek.com")).replace(/\/+$/, "")
  readonly property string balanceBase: String(setting("balanceBase", "https://api.deepseek.com")).replace(/\/+$/, "")
  readonly property int refreshSec: Math.max(60, Math.min(3600, Number(setting("refreshIntervalSec", 300))))

  // apiKeyText wins, then the environment. Both are normalised so a JSON blob
  // copied out of a secret store still works.
  readonly property string apiKey: {
    var fromFile = Usage.normalizeToken(root.apiKeyText)
    if (fromFile !== "") return fromFile
    return Usage.normalizeToken(Quickshell.env("DEEPSEEK_API_KEY") || "")
  }

  // --- state --------------------------------------------------------------

  property string state: "loading" // loading | ok | unconfigured | expired | error
  property string tokenText: ""
  property bool tokenLoaded: false
  property string apiKeyText: ""
  property string activeToken: ""
  property string amountUrl: ""
  property string costUrl: ""
  property string balanceUrl: ""
  property var collected: null
  property var keys: []
  property var todayCounters: null
  property var weekCounters: null
  property var monthCounters: null
  property var balance: null
  property string lastError: ""
  property real lastUpdated: 0
  property int pending: 0
  property int tzOffset: 0
  property string amountBody: ""
  property string costBody: ""
  property bool amountFailed: false
  property bool costFailed: false
  // Band state is derived from the clock, so it ticks independently of the
  // usage refresh.
  property date now: new Date()

  // --- refresh pipeline ---------------------------------------------------

  function refresh() {
    if (amountProc.running || costProc.running || tokenProc.running) return
    if (root.tokenCommand !== "") {
      tokenKillTimer.restart()
      tokenProc.running = true
      return
    }
    if (!root.tokenLoaded) return
    if (root.tokenText === "") {
      root.state = "unconfigured"
      return
    }
    root.fetchUsage()
  }

  function refreshIfStale() {
    if (Date.now() - root.lastUpdated > 60000) root.refresh()
  }

  function fetchUsage() {
    root.activeToken = root.tokenText
    root.tzOffset = Usage.tzOffsetSec(new Date())
    root.keys = Usage.dayKeysBack(Date.now(), root.tzOffset, 30)
    if (root.keys.length === 0) {
      root.state = "error"
      root.lastError = "Could not build the date range"
      return
    }
    var start = Usage.epochForDayStart(root.keys[0], root.tzOffset)
    var end = start + 30 * 86400
    var query = "?start=" + start + "&end=" + end + "&tz=" + root.tzOffset
    root.amountUrl = root.endpointBase + "/api/v0/usage/by_api_key/amount" + query
    root.costUrl = root.endpointBase + "/api/v0/usage/by_api_key/cost" + query
    root.balanceUrl = root.balanceBase + "/user/balance"

    root.amountBody = ""
    root.costBody = ""
    root.amountFailed = false
    root.costFailed = false
    root.lastError = ""
    root.pending = 2
    amountProc.running = true
    costProc.running = true
    root.refreshBalance()
  }

  function refreshBalance() {
    if (balanceProc.running) return
    if (root.balanceUrl === "" || root.apiKey === "") {
      root.balance = null
      return
    }
    balanceProc.running = true
  }

  function onUsageDone(kind, exitCode, stdout, stderrText) {
    var text = String(stdout || "")
    if (kind === "amount") root.amountBody = text
    else root.costBody = text

    if (exitCode !== 0 && text.trim() === "") {
      if (kind === "amount") root.amountFailed = true
      else root.costFailed = true
      root.lastError = String(stderrText || "").trim() || ("Request failed (exit " + exitCode + ")")
    }

    root.pending = Math.max(0, root.pending - 1)
    if (root.pending === 0) root.finish()
  }

  function stateForCode(code) {
    var value = Number(code)
    if (value === 40001 || value === 40003) return "expired"
    if (value === 40002) return "unconfigured"
    return "error"
  }

  function finish() {
    if (root.amountFailed || root.costFailed) {
      // The bar keeps the previous figure, dimmed, rather than blanking out.
      root.state = "error"
      return
    }

    var amountEnvelope = Usage.parseEnvelope(root.amountBody)
    if (!amountEnvelope.ok) {
      root.state = root.stateForCode(amountEnvelope.code)
      root.lastError = amountEnvelope.message
      return
    }
    var costEnvelope = Usage.parseEnvelope(root.costBody)
    if (!costEnvelope.ok) {
      root.state = root.stateForCode(costEnvelope.code)
      root.lastError = costEnvelope.message
      return
    }

    var tz = root.tzOffset
    var next = Usage.collect(Usage.parseAmount(amountEnvelope.data),
      Usage.parseCost(costEnvelope.data), tz)
    root.collected = next
    var today = Usage.todayKey(Date.now(), tz)
    root.monthCounters = Usage.sumRange(next, root.keys)
    root.weekCounters = Usage.sumRange(next, root.keys.slice(-7))
    root.todayCounters = Usage.sumRange(next, [today])
    root.lastUpdated = Date.now()
    root.lastError = ""
    root.state = "ok"
  }

  // {is_available, balance_infos:[{currency,total_balance,granted_balance,topped_up_balance}]}
  function applyBalance(text) {
    var raw = String(text || "").trim()
    if (raw === "") {
      root.balance = null
      return
    }
    var parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      root.balance = null
      return
    }
    var infos = parsed && parsed.balance_infos ? parsed.balance_infos : []
    if (!infos.length) {
      root.balance = null
      return
    }
    var info = infos[0]
    for (var i = 0; i < infos.length; i++) {
      if (String(infos[i].currency || "").toUpperCase() === root.primaryCurrency) {
        info = infos[i]
        break
      }
    }
    root.balance = {
      currency: String(info.currency || "USD").toUpperCase(),
      total: Number(info.total_balance) || 0,
      granted: Number(info.granted_balance) || 0,
      toppedUp: Number(info.topped_up_balance) || 0,
      available: parsed.is_available !== false
    }
  }

  // --- readouts -----------------------------------------------------------

  readonly property string primaryCurrency: root.collected ? Usage.primaryCurrency(root.collected) : "USD"
  readonly property string todayCostText: root.todayCounters ? Usage.formatCosts(root.todayCounters, root.primaryCurrency) : "\u2014"
  readonly property string barText: ((root.state === "ok" || root.state === "error") && root.todayCounters) ? root.todayCostText : "\u2014"
  readonly property color barColor: root.state === "expired" ? root.urgent
    : root.state === "error" ? Qt.darker(root.foreground, 1.5)
    : root.foreground
  readonly property string barTooltip: {
    if (root.state === "unconfigured") return "DeepSeek \u00b7 token not configured"
    if (root.state === "expired") return "DeepSeek \u00b7 session token expired"
    if (root.state === "error") return "DeepSeek \u00b7 update failed"
    if (root.state === "loading") return "DeepSeek \u00b7 loading usage"
    return "DeepSeek \u00b7 today " + root.todayCostText + " \u00b7 "
      + Usage.formatTokens(Usage.tokens(root.todayCounters))
      + (root.peak ? " \u00b7 peak" : " \u00b7 off-peak")
  }
  readonly property bool hasStats: root.todayCounters !== null
    && root.state !== "loading" && root.state !== "unconfigured" && root.state !== "expired"
  readonly property string updatedClock: root.lastUpdated > 0
    ? Qt.formatTime(new Date(root.lastUpdated), "HH:mm") : "\u2014"
  readonly property bool peak: Pricing.isPeakAt(root.now)
  readonly property int localOffsetMinutes: -root.now.getTimezoneOffset()
  // Off-peak wears the theme's normal foreground, peak the urgent role; no
  // colour is hard-coded, so the tint follows the palette.
  readonly property color bandColor: root.peak ? root.urgent : root.foreground
  readonly property string pricingStatusText: root.peak ? "Peak" : "Off-peak (discount)"
  readonly property string pricingNextText: (root.peak ? "Off-peak at " : "Peak at ")
    + Pricing.formatClock(Pricing.nextChange(root.now), root.localOffsetMinutes)
  readonly property string pricingWindowsText: Pricing.formatWindows(root.localOffsetMinutes)
  readonly property string footerText: {
    if (root.state === "error") return "Update failed: " + (root.lastError || "unknown error")
    if (root.state === "ok") return "Updated " + root.updatedClock + " \u00b7 platform.deepseek.com/usage"
    if (root.state === "loading") return "Fetching usage\u2026"
    return "platform.deepseek.com/usage"
  }

  // Up to six models, ranked by this window's spend and then by volume.
  readonly property var modelList: {
    var models = root.collected && root.collected.models ? root.collected.models : ({})
    var rows = []
    for (var name in models) {
      if (!Object.prototype.hasOwnProperty.call(models, name)) continue
      rows.push({ name: name, counters: models[name] })
    }
    var currency = root.primaryCurrency
    rows.sort(function(a, b) {
      var costA = Number(a.counters.costs[currency] || 0)
      var costB = Number(b.counters.costs[currency] || 0)
      if (costB !== costA) return costB - costA
      return Usage.tokens(b.counters) - Usage.tokens(a.counters)
    })
    return rows.slice(0, 6)
  }

  // --- processes ----------------------------------------------------------

  Process {
    id: amountProc
    command: ["bash", root.pluginDir + "/fetch.sh", root.amountUrl]
    environment: ({ DS_TOKEN: root.activeToken })
    stdout: StdioCollector {
      id: amountOut
      waitForEnd: true
    }
    stderr: StdioCollector {
      id: amountErr
      waitForEnd: true
    }
    onExited: function(exitCode) {
      root.onUsageDone("amount", exitCode, amountOut.text, amountErr.text)
    }
  }

  Process {
    id: costProc
    command: ["bash", root.pluginDir + "/fetch.sh", root.costUrl]
    environment: ({ DS_TOKEN: root.activeToken })
    stdout: StdioCollector {
      id: costOut
      waitForEnd: true
    }
    stderr: StdioCollector {
      id: costErr
      waitForEnd: true
    }
    onExited: function(exitCode) {
      root.onUsageDone("cost", exitCode, costOut.text, costErr.text)
    }
  }

  Process {
    id: balanceProc
    command: ["bash", root.pluginDir + "/fetch.sh", root.balanceUrl]
    environment: ({ DS_TOKEN: root.apiKey })
    stdout: StdioCollector {
      id: balanceOut
      waitForEnd: true
    }
    onExited: function(exitCode) {
      if (exitCode === 0) root.applyBalance(balanceOut.text)
      else root.balance = null
    }
  }

  Process {
    id: tokenProc
    command: ["bash", "-c", root.tokenCommand]
    stdout: StdioCollector {
      id: tokenOut
      waitForEnd: true
    }
    // Never call refresh() from here: the command would run forever.
    onExited: function(exitCode) {
      tokenKillTimer.stop()
      var value = exitCode === 0 ? Usage.normalizeToken(tokenOut.text) : ""
      root.tokenText = value
      if (value === "") root.state = "unconfigured"
      else root.fetchUsage()
    }
  }

  Timer {
    id: tokenKillTimer
    interval: 10000
    repeat: false
    onTriggered: {
      if (!tokenProc.running) return
      tokenProc.signal(9)
      tokenText = ""
      state = "unconfigured"
    }
  }

  Timer {
    interval: 30000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.now = new Date()
  }

  Timer {
    id: refreshTimer
    interval: root.refreshSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  onOpenedChanged: {
    if (opened) root.refreshIfStale()
  }

  FileView {
    id: tokenView
    path: root.tokenCommand === "" ? root.tokenPath : ""
    watchChanges: true
    printErrors: false
    onLoaded: {
      root.tokenLoaded = true
      root.tokenText = Usage.normalizeToken(text())
      root.refresh()
    }
    onFileChanged: reload()
    onLoadFailed: {
      if (root.tokenCommand !== "") return
      root.tokenLoaded = true
      root.tokenText = ""
      root.state = "unconfigured"
    }
  }

  FileView {
    id: apiKeyView
    path: root.apiKeyPath
    watchChanges: true
    printErrors: false
    onLoaded: {
      root.apiKeyText = Usage.normalizeToken(text())
      if (root.collected) root.refreshBalance()
    }
    onFileChanged: reload()
    onLoadFailed: {
      root.apiKeyText = ""
      root.balance = null
    }
  }

  // --- bar ----------------------------------------------------------------

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: root.vertical
    text: root.barText
    horizontalMargin: 5
    tooltipText: root.barTooltip
    fixedWidth: root.vertical ? -1 : Math.ceil(barRow.implicitWidth + button.scaledHorizontalMargin * 2)
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
      else if (buttonCode === Qt.MiddleButton) root.refresh()
      else if (buttonCode === Qt.RightButton) Qt.openUrlExternally("https://platform.deepseek.com/usage")
    }

    Row {
      id: barRow
      visible: !root.vertical
      anchors.centerIn: parent
      spacing: Style.space(4)

      DeepSeekMark {
        anchors.verticalCenter: parent.verticalCenter
        iconSize: Style.bar.iconFont
        color: root.bandColor
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.barText
        color: root.barColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        renderType: Text.NativeRendering
      }
    }
  }

  // --- panel --------------------------------------------------------------

  KeyboardPanel {
    id: popup
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(Style.space(340))
    contentHeight: popup.fittedContentHeight(content.implicitHeight, Style.space(520))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()

      Column {
        id: content
        width: parent ? parent.width : implicitWidth
        spacing: Style.space(12)

        PanelHero {
          id: heroCard
          width: parent.width
          title: "DeepSeek"
          meta: root.todayCounters !== null ? "Today " + root.todayCostText : "Usage unavailable"
          detail: "TODAY"
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            DeepSeekMark {
              iconSize: heroCard.iconSize
              color: root.foreground
            }
          }
        }

        Column {
          width: parent.width
          spacing: Style.spacing.labelGap

          PanelSeparator {
            foreground: root.foreground
          }

          PanelSectionHeader {
            text: "PRICING"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          InfoPair {
            label: "Status"
            value: root.pricingStatusText
            valueColor: root.bandColor
          }
          InfoPair {
            label: "Next change (" + Pricing.formatOffset(root.localOffsetMinutes) + ")"
            value: root.pricingNextText
          }
          InfoPair {
            label: "Windows"
            value: root.pricingWindowsText
          }
          InfoPair {
            label: "Days"
            value: "Mon-Fri UTC"
          }
        }

        Text {
          width: parent.width
          visible: root.state === "loading"
          text: "Loading usage\u2026"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Column {
          width: parent.width
          visible: root.state === "unconfigured" || root.state === "expired"
          spacing: Style.space(8)

          PanelSeparator {
            foreground: root.foreground
          }

          Text {
            width: parent.width
            text: root.state === "expired" ? "Session expired" : "No session token"
            color: root.state === "expired" ? root.urgent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: true
          }

          Text {
            width: parent.width
            text: root.state === "expired"
              ? "Open platform.deepseek.com, sign in again, and replace the token in "
                + root.tokenPath + ". The session token lasts about 48 hours."
              : "Sign in at platform.deepseek.com, copy localStorage.userToken in the browser console,"
                + " and save it to " + root.tokenPath + " (chmod 600)."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }
        }

        Column {
          width: parent.width
          visible: root.hasStats
          spacing: Style.spacing.labelGap

          PanelSectionHeader {
            text: "TODAY"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          InfoPair {
            label: "Cost"
            value: Usage.formatCosts(root.todayCounters, root.primaryCurrency)
          }
          InfoPair {
            label: "Tokens"
            value: Usage.formatTokens(Usage.tokens(root.todayCounters))
          }
          InfoPair {
            label: "In / out"
            value: Usage.formatTokens(Usage.inputTokens(root.todayCounters)) + " / "
              + Usage.formatTokens(root.todayCounters ? root.todayCounters.output : 0)
          }
          InfoPair {
            label: "Requests"
            value: Usage.formatCount(root.todayCounters ? root.todayCounters.requests : 0)
          }
          InfoPair {
            label: "Cache hit rate"
            value: Usage.formatPercent(Usage.cacheRate(root.todayCounters))
          }
        }

        Column {
          width: parent.width
          visible: root.hasStats
          spacing: Style.spacing.labelGap

          PanelSeparator {
            foreground: root.foreground
          }

          PanelSectionHeader {
            text: "LAST 7 / 30 DAYS"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          InfoPair {
            label: "Last 7 days"
            value: Usage.formatCosts(root.weekCounters, root.primaryCurrency) + " \u00b7 "
              + Usage.formatTokens(Usage.tokens(root.weekCounters)) + " tokens"
          }
          InfoPair {
            label: "Last 30 days"
            value: Usage.formatCosts(root.monthCounters, root.primaryCurrency) + " \u00b7 "
              + Usage.formatTokens(Usage.tokens(root.monthCounters)) + " tokens"
          }
        }

        Column {
          width: parent.width
          visible: root.hasStats && root.modelList.length > 0
          spacing: Style.spacing.labelGap

          PanelSeparator {
            foreground: root.foreground
          }

          PanelSectionHeader {
            text: "BY MODEL \u00b7 30 DAYS"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Repeater {
            model: root.modelList
            delegate: InfoPair {
              required property var modelData
              label: String(modelData.name)
              value: Usage.formatCosts(modelData.counters, root.primaryCurrency) + " \u00b7 "
                + Usage.formatTokens(Usage.tokens(modelData.counters))
            }
          }
        }

        Column {
          width: parent.width
          visible: root.balance !== null
          spacing: Style.spacing.labelGap

          PanelSeparator {
            foreground: root.foreground
          }

          PanelSectionHeader {
            text: "BALANCE"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          InfoPair {
            label: "Remaining"
            value: root.balance !== null ? Usage.formatAmount(root.balance.total, root.balance.currency) : "\u2014"
            valueColor: root.balance !== null && (!root.balance.available || root.balance.total <= 0)
              ? root.urgent : root.foreground
          }
          InfoPair {
            label: "Granted"
            value: root.balance !== null ? Usage.formatAmount(root.balance.granted, root.balance.currency) : "\u2014"
          }
          InfoPair {
            label: "Topped up"
            value: root.balance !== null ? Usage.formatAmount(root.balance.toppedUp, root.balance.currency) : "\u2014"
          }
        }

        Text {
          width: parent.width
          text: root.footerText
          color: root.state === "error" ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }

  IpcHandler {
    enabled: root.ipcTarget !== ""
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string {
      root.refresh()
      return "ok"
    }
  }

  // Whale mark, tinted with the theme foreground. The asset is white, so a
  // MultiEffect recolours it; kept inline so the plugin folder is never
  // imported as a QML module path (only Panel.qml itself is loaded).
  component DeepSeekMark: Item {
    id: mark

    property real iconSize: Style.font.display
    property color color: root.foreground

    implicitWidth: iconSize
    implicitHeight: iconSize

    Image {
      id: markImage
      anchors.fill: parent
      source: Qt.resolvedUrl("assets/deepseek.svg")
      fillMode: Image.PreserveAspectFit
      smooth: true
      sourceSize.width: 256
      sourceSize.height: 256
    }

    MultiEffect {
      anchors.fill: markImage
      source: markImage
      colorization: 1.0
      colorizationColor: mark.color
    }
  }

  component InfoPair: RowLayout {
    property string label: ""
    property string value: ""
    property color valueColor: root.foreground

    width: parent ? parent.width : implicitWidth
    spacing: Style.space(8)

    Text {
      text: parent.label
      color: root.foreground
      opacity: 0.6
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      Layout.fillWidth: true
      text: parent.value
      color: parent.valueColor
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
      horizontalAlignment: Text.AlignRight
    }
  }
}
