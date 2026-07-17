const CARD_VERSION = "1.20.0";
const BUILD_COMMIT = "937941a";

const DEFAULTS = {
  title: "Home topology",
  show_unassigned: false,
  show_only_labeled: true,
  initial_label_selection: "all",
  show_entities: false,
  web_show_properties: undefined,
  tree_show_properties: true,
  show_status: true,
  hide_child_lock: true,
  max_statuses: 3,
  topology_zoom: 1,
  web_zoom: undefined,
  tree_font_scale: 1,
  layout: "web",
  floors_expanded: true,
  areas_expanded: true,
  tree_devices_expanded: false,
  map_height: "auto",
  header_color: "#263f4b",
  datetime_color: "#ff9900",
};

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const nameOf = (item, fallback) => item?.name_by_user || item?.name || fallback;

const HA_COLORS = {
  red: "#f44336", pink: "#e91e63", purple: "#9c27b0", "deep-purple": "#673ab7",
  indigo: "#3f51b5", blue: "#2196f3", "light-blue": "#03a9f4", cyan: "#00bcd4",
  teal: "#009688", green: "#4caf50", "light-green": "#8bc34a", lime: "#cddc39",
  yellow: "#ffeb3b", amber: "#ffc107", orange: "#ff9800", "deep-orange": "#ff5722",
  brown: "#795548", grey: "#9e9e9e", "light-grey": "#c7c7c7", "dark-grey": "#616161",
  "blue-grey": "#607d8b", black: "#212121", white: "#ffffff",
};

const safeColor = (value, fallback = "var(--primary-color,#03a9f4)") => {
  const color = String(value || "").trim();
  if (HA_COLORS[color.toLowerCase()]) return HA_COLORS[color.toLowerCase()];
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
};

const contrastColor = (color) => {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return "#ffffff";
  const value = Number.parseInt(match[1], 16);
  const channels = [value >> 16, (value >> 8) & 255, value & 255].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.42 ? "#151515" : "#ffffff";
};

export function buildTopology(areas, devices, entities, labels, showUnassigned = true, floors = []) {
  const labelsById = new Map(labels.map((label) => [label.label_id, label]));
  const unassignedAreaIds = new Set(areas
    .filter((area) => area.name?.trim().toLowerCase() === "unassigned")
    .map((area) => area.area_id));
  const entitiesByDevice = new Map();
  for (const entity of entities) {
    if (!entity.device_id) continue;
    const list = entitiesByDevice.get(entity.device_id) || [];
    list.push(entity);
    entitiesByDevice.set(entity.device_id, list);
  }

  const nodes = areas.filter((area) => !unassignedAreaIds.has(area.area_id)).map((area) => ({
    id: area.area_id,
    name: area.name,
    icon: area.icon || "mdi:floor-plan",
    floorId: area.floor_id || null,
    temperatureEntityId: area.temperature_entity_id || area.temperature_sensor_entity_id || area.temperature_sensor || area.temperature_entity || null,
    devices: [],
    entities: [],
  }));
  const areaById = new Map(nodes.map((area) => [area.id, area]));
  const unassigned = { id: "__unassigned__", name: "Unassigned", icon: "mdi:help-circle-outline", devices: [] };

  for (const device of devices) {
    const deviceEntities = entitiesByDevice.get(device.id) || [];
    const inheritedArea = deviceEntities.find((entity) => entity.area_id)?.area_id;
    const requestedArea = device.area_id || inheritedArea;
    const area = unassignedAreaIds.has(requestedArea) ? unassigned : (areaById.get(requestedArea) || unassigned);
    const deviceLabels = (device.labels || []).map((id) => labelsById.get(id)).filter(Boolean);
    const iconLabel = deviceLabels.find((label) => label.icon);
    const colorLabel = iconLabel?.color ? iconLabel : deviceLabels.find((label) => label.color);
    area.devices.push({
      id: device.id,
      name: nameOf(device, device.model || "Unnamed device"),
      manufacturer: device.manufacturer || "",
      model: device.model || "",
      icon: iconLabel?.icon || "mdi:devices",
      color: colorLabel?.color || "",
      labels: deviceLabels,
      entities: deviceEntities,
    });
  }

  for (const entity of entities) {
    if (!entity.area_id || entity.device_id) continue;
    areaById.get(entity.area_id)?.entities.push(entity);
  }

  for (const area of nodes) area.devices.sort((a, b) => a.name.localeCompare(b.name));
  if (showUnassigned && unassigned.devices.length) nodes.push(unassigned);
  return nodes;
}

class AreaTopologyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._loadedForConnection = null;
    this._data = null;
    this._collapsedAreas = new Set();
    this._collapsedFloors = new Set();
    this._expandedTreeDevices = new Set();
  }

  setConfig(config) {
    this._config = { ...DEFAULTS, ...config };
    this._config.web_show_properties = config.web_show_properties ?? config.show_entities ?? false;
    const cardPreferenceType = this._standaloneLcars ? "lcars-home-card" : "area-topology-card";
    const preferenceKey = `${cardPreferenceType}:${window.location.pathname}:${this._config.title}`;
    if (this._preferenceKey !== preferenceKey) {
      this._preferenceKey = preferenceKey;
      const preferences = this.loadPreferences();
      this._showUnassigned = preferences.showUnassigned ?? this._config.show_unassigned;
      this._labelsOnly = preferences.labelsOnly ?? this._config.show_only_labeled;
      this._unassignedLabelsOnly = preferences.unassignedLabelsOnly ?? false;
      this._unassignedSearch = preferences.unassignedSearch ?? "";
      const requestedLayout = preferences.layoutMode || this._config.layout;
      this._layoutMode = this._standaloneLcars
        ? "lcars"
        : (["web", "tree"].includes(requestedLayout) ? requestedLayout : "web");
      this._savedSelectedLabels = Array.isArray(preferences.selectedLabels) ? preferences.selectedLabels : null;
      this._savedCollapsedAreas = Array.isArray(preferences.collapsedAreas) ? preferences.collapsedAreas : null;
      this._savedCollapsedFloors = Array.isArray(preferences.collapsedFloors) ? preferences.collapsedFloors : null;
      this._savedExpandedTreeDevices = Array.isArray(preferences.expandedTreeDevices) ? preferences.expandedTreeDevices : null;
      this._savedWebZoom = Number.isFinite(Number(preferences.webZoom)) ? Number(preferences.webZoom) : null;
      this._savedTreeScale = Number.isFinite(Number(preferences.treeScale)) ? Number(preferences.treeScale) : null;
    }
    if (this._webZoom === undefined) this._webZoom = Math.max(0.65, Math.min(1.8, this._savedWebZoom ?? (Number(config.web_zoom ?? config.topology_zoom) || 1)));
    if (this._treeScale === undefined) this._treeScale = Math.max(0.65, Math.min(1.8, this._savedTreeScale ?? (Number(this._config.tree_font_scale) || 1)));
    this.render();
  }

  loadPreferences() {
    try {
      const stored = window.localStorage.getItem(this._preferenceKey);
      return stored ? JSON.parse(stored) : {};
    } catch (_error) {
      return {};
    }
  }

  savePreferences() {
    try {
      window.localStorage.setItem(this._preferenceKey, JSON.stringify({
        showUnassigned: this._showUnassigned,
        labelsOnly: this._labelsOnly,
        unassignedLabelsOnly: this._unassignedLabelsOnly,
        unassignedSearch: this._unassignedSearch,
        layoutMode: this._layoutMode,
        selectedLabels: this._selectedLabels ? [...this._selectedLabels] : this._savedSelectedLabels,
        collapsedAreas: [...this._collapsedAreas],
        collapsedFloors: [...this._collapsedFloors],
        expandedTreeDevices: [...this._expandedTreeDevices],
        webZoom: this._webZoom,
        treeScale: this._treeScale,
      }));
    } catch (_error) {
      // Storage can be unavailable in restricted browser modes; the card still works for this visit.
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (hass?.connection && this._loadedForConnection !== hass.connection) {
      this._loadedForConnection = hass.connection;
      this.loadRegistries();
    } else if (this._data) {
      if (this._standaloneLcars && this._lcarsPopupEntity) {
        const chart = this.shadowRoot?.querySelector("[data-lcars-history] > *");
        if (chart) chart.hass = hass;
        const stateObj = hass.states?.[this._lcarsPopupEntity];
        const value = this.shadowRoot?.querySelector("[data-lcars-popup-value]");
        if (stateObj && value) value.textContent = hass.formatEntityState?.(stateObj) || stateObj.state;
      } else if (this._standaloneLcars && ["security", "engineering", "captains_log"].includes(this._lcarsSelectedView)) {
        for (const card of this.shadowRoot?.querySelectorAll(".lcars-camera-card > *,.lcars-engineering-card > *,.lcars-captains-log-card > *") || []) card.hass = hass;
        for (const value of this.shadowRoot?.querySelectorAll("[data-camera-state]") || []) value.textContent = hass.states?.[value.dataset.cameraState]?.state || "unavailable";
        for (const value of this.shadowRoot?.querySelectorAll("[data-engineering-metric]") || []) {
          const metric = this._config.engineering?.metrics?.[Number(value.dataset.engineeringMetric)];
          if (metric) value.textContent = this.engineeringMetricValue(metric);
        }
      } else {
        this.render();
      }
    }
  }

  async loadRegistries() {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const call = (type) => this._hass.callWS({ type });
      const [areas, devices, entities, labels, floors] = await Promise.all([
        call("config/area_registry/list"),
        call("config/device_registry/list"),
        call("config/entity_registry/list"),
        call("config/label_registry/list"),
        call("config/floor_registry/list").catch(() => []),
      ]);
      this._labels = labels;
      this._floors = floors;
      if (this._standaloneLcars) {
        this._selectedLabels = new Set(labels
          .filter((label) => this.matchesConfiguredItem("labels", label.label_id, label.name))
          .map((label) => label.label_id));
      } else if (!this._selectedLabels) {
        const availableLabelIds = new Set(labels.map((label) => label.label_id));
        this._selectedLabels = this._savedSelectedLabels
          ? new Set(this._savedSelectedLabels.filter((labelId) => availableLabelIds.has(labelId)))
          : (this._config.initial_label_selection === "none" ? new Set() : new Set(availableLabelIds));
      }
      this._data = buildTopology(areas, devices, entities, labels, true, floors);
      if (!this._hierarchyDefaultsInitialized) {
        const areaIds = new Set(this._data.filter((area) => area.id !== "__unassigned__").map((area) => area.id));
        const floorIds = new Set(this.floorGroups().map((floor) => floor.id));
        const deviceIds = new Set(this._data.flatMap((area) => area.devices.map((device) => device.id)));
        if (this._savedCollapsedAreas) this._collapsedAreas = new Set(this._savedCollapsedAreas.filter((id) => areaIds.has(id)));
        else if (!this._config.areas_expanded) this._collapsedAreas = new Set(areaIds);
        if (this._savedCollapsedFloors) this._collapsedFloors = new Set(this._savedCollapsedFloors.filter((id) => floorIds.has(id)));
        else if (!this._config.floors_expanded && this.hasFloorLevel()) this._collapsedFloors = new Set(floorIds);
        if (this._savedExpandedTreeDevices) this._expandedTreeDevices = new Set(this._savedExpandedTreeDevices.filter((id) => deviceIds.has(id)));
        else if (this._config.tree_devices_expanded && this._config.tree_show_properties) {
          this._expandedTreeDevices = new Set(this._data.flatMap((area) => area.devices.map((device) => device.id)));
        }
        this._hierarchyDefaultsInitialized = true;
      }
    } catch (error) {
      this._error = error?.message || String(error);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  connectedCallback() {
    this.startLcarsClock();
    if (this._eventsBound) return;
    this._eventsBound = true;
    this.shadowRoot.addEventListener("scroll", (event) => {
      if (event.target.classList?.contains("unassigned-list")) {
        this._unassignedScrollTop = event.target.scrollTop;
      }
    }, true);
    this.shadowRoot.addEventListener("input", (event) => {
      if (event.target.matches?.("[data-entity-level]")) {
        const meter = event.target.closest(".lcars-meter");
        meter?.style.setProperty("--level", `${event.target.value}%`);
        const value = meter?.querySelector("b");
        if (value) value.textContent = `${Math.round(Number(event.target.value))}%`;
        return;
      }
      if (!event.target.matches?.("[data-unassigned-search]")) return;
      this._unassignedSearch = event.target.value;
      this._restoreUnassignedSearchFocus = true;
      this.savePreferences();
      this.render();
    });
    this.shadowRoot.addEventListener("change", (event) => {
      if (!event.target.matches?.("[data-entity-level]")) return;
      this.setEntityLevel(event.target.dataset.entityLevel, event.target.dataset.levelDomain, Number(event.target.value), event.target);
    });
    this.shadowRoot.addEventListener("click", (event) => {
      if (event.target.closest("[data-entity-level]")) return;
      if (Date.now() < (this._suppressDeviceClickUntil || 0) && event.target.closest("[data-device-drag]")) {
        event.preventDefault();
        return;
      }
      const floorNavId = event.target.closest("[data-floor-nav]")?.dataset.floorNav;
      if (floorNavId) {
        if (this._standaloneLcars) {
          if (floorNavId.startsWith("__menu_") && floorNavId.endsWith("__")) {
            this._lcarsSelectedView = `menu:${floorNavId.slice(7, -2)}`;
          } else if (["__weather__", "__security__", "__engineering__", "__captains_log__"].includes(floorNavId)) {
            this._lcarsSelectedView = floorNavId.slice(2, -2);
          } else {
            this._lcarsSelectedView = "floor";
            this._lcarsSelectedFloor = floorNavId;
          }
          this.render();
          if (floorNavId === "__weather__") this.loadLcarsWeatherForecast();
          return;
        }
        const floor = [...this.shadowRoot.querySelectorAll("[data-lcars-floor]")]
          .find((entry) => entry.dataset.lcarsFloor === floorNavId);
        floor?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const action = event.target.closest("[data-topology-action]")?.dataset.topologyAction;
      if (action === "close-lcars-popup" && (event.target.classList?.contains("lcars-popup-backdrop") || event.target.closest(".lcars-popup-top button"))) {
        this._lcarsPopupEntity = null;
        this.render();
        return;
      }
      if (action === "expand") {
        this.captureViewportFocus();
        this._collapsedAreas.clear();
        this._collapsedFloors.clear();
        this._expandedTreeDevices = new Set(this._data?.flatMap((area) => area.devices.map((device) => device.id)) || []);
        this.savePreferences();
        this.render();
        return;
      }
      if (action === "collapse") {
        this.captureViewportFocus();
        this._expandedTreeDevices.clear();
        if (this.hasFloorLevel()) {
          this._collapsedFloors = new Set(this.floorGroups().map((floor) => floor.id));
          this._collapsedAreas.clear();
        } else {
          this._collapsedAreas = new Set(this._data?.map((area) => area.id) || []);
        }
        this.savePreferences();
        this.render();
        return;
      }
      if (["layout-web", "layout-tree"].includes(action)) {
        this._layoutMode = action.replace("layout-", "");
        if (this._layoutMode === "tree") this.collapseTreeProperties();
        this.savePreferences();
        this.render();
        return;
      }
      if (action === "zoom-in") {
        this.setZoom(this.currentScale() + 0.1);
        return;
      }
      if (action === "zoom-out") {
        this.setZoom(this.currentScale() - 0.1);
        return;
      }
      if (action === "zoom-reset") {
        this.setZoom(this._layoutMode === "tree"
          ? Number(this._config.tree_font_scale) || 1
          : Number(this._config.web_zoom ?? this._config.topology_zoom) || 1);
        return;
      }
      if (action === "unassigned") {
        this._showUnassigned = !this._showUnassigned;
        this.savePreferences();
        this.render();
        return;
      }
      if (action === "labels") {
        this._labelsOnly = !this._labelsOnly;
        this.collapseTreeProperties();
        this.centerWebAfterFilter();
        this.savePreferences();
        this.render();
        return;
      }
      if (action === "unassigned-labels") {
        this._unassignedLabelsOnly = !this._unassignedLabelsOnly;
        this.savePreferences();
        this.render();
        return;
      }
      if (action === "all-labels") {
        const allSelected = this._selectedLabels?.size === this._labels?.length;
        this._selectedLabels = new Set(allSelected ? [] : (this._labels || []).map((label) => label.label_id));
        this.collapseTreeProperties();
        this.centerWebAfterFilter();
        this.savePreferences();
        this.render();
        return;
      }
      const labelId = event.target.closest("[data-label-toggle]")?.dataset.labelToggle;
      if (labelId) {
        this._selectedLabels ||= new Set();
        this._selectedLabels.has(labelId) ? this._selectedLabels.delete(labelId) : this._selectedLabels.add(labelId);
        this.collapseTreeProperties();
        this.centerWebAfterFilter();
        this.savePreferences();
        this.render();
        return;
      }
      const areaId = event.target.closest("[data-area-toggle]")?.dataset.areaToggle;
      if (areaId) {
        this.captureViewportFocus();
        this._collapsedAreas.has(areaId) ? this._collapsedAreas.delete(areaId) : this._collapsedAreas.add(areaId);
        this.savePreferences();
        this.render();
        return;
      }
      const floorId = event.target.closest("[data-floor-toggle]")?.dataset.floorToggle;
      if (floorId) {
        this.captureViewportFocus();
        this._collapsedFloors.has(floorId) ? this._collapsedFloors.delete(floorId) : this._collapsedFloors.add(floorId);
        this.savePreferences();
        this.render();
        return;
      }
      const areaConfigId = event.target.closest("[data-area-config]")?.dataset.areaConfig;
      if (areaConfigId) {
        this.navigate(`/config/areas/area/${encodeURIComponent(areaConfigId)}`);
        return;
      }
      const floorConfigId = event.target.closest("[data-floor-config]")?.dataset.floorConfig;
      if (floorConfigId) {
        this.openFloorConfig(floorConfigId);
        return;
      }
      const deviceToggleId = event.target.closest("[data-device-toggle]")?.dataset.deviceToggle;
      if (deviceToggleId) {
        this._expandedTreeDevices.has(deviceToggleId) ? this._expandedTreeDevices.delete(deviceToggleId) : this._expandedTreeDevices.add(deviceToggleId);
        this.savePreferences();
        this.render();
        return;
      }
      const entityToggleId = event.target.closest("[data-entity-toggle]")?.dataset.entityToggle;
      if (entityToggleId) {
        this.toggleEntity(entityToggleId, event.target.closest("[data-entity-toggle]"));
        return;
      }
      const target = event.target.closest("[data-entity]");
      if (target) {
        if (this._standaloneLcars) {
          this._lcarsPopupEntity = target.dataset.entity;
          this.render();
          return;
        }
        this.dispatchEvent(new CustomEvent("hass-more-info", {
          bubbles: true,
          composed: true,
          detail: { entityId: target.dataset.entity },
        }));
        return;
      }
      const deviceId = event.target.closest("[data-device]")?.dataset.device;
      if (deviceId) {
        this.navigate(`/config/devices/device/${encodeURIComponent(deviceId)}`);
        return;
      }
    });
    this.shadowRoot.addEventListener("dragstart", (event) => {
      if (event.target.closest("[data-entity-level]")) {
        event.preventDefault();
        return;
      }
      const device = event.target.closest("[data-unassigned-device],[data-device-drag]");
      if (!device || !event.dataTransfer) return;
      const deviceId = device.dataset.unassignedDevice || device.dataset.deviceDrag;
      if (!deviceId) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", deviceId);
      device.classList.add("dragging");
    });
    this.shadowRoot.addEventListener("dragend", (event) => {
      event.target.closest("[data-unassigned-device],[data-device-drag]")?.classList.remove("dragging");
      this._suppressDeviceClickUntil = Date.now() + 300;
      this.shadowRoot.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
    });
    this.shadowRoot.addEventListener("dragover", (event) => {
      const area = event.target.closest("[data-area-drop]");
      if (!area) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      area.classList.add("drop-target");
    });
    this.shadowRoot.addEventListener("dragleave", (event) => {
      const area = event.target.closest("[data-area-drop]");
      if (area && !area.contains(event.relatedTarget)) area.classList.remove("drop-target");
    });
    this.shadowRoot.addEventListener("drop", (event) => {
      const area = event.target.closest("[data-area-drop]");
      if (!area || !event.dataTransfer) return;
      event.preventDefault();
      area.classList.remove("drop-target");
      const deviceId = event.dataTransfer.getData("text/plain");
      if (deviceId) this.assignDeviceToArea(deviceId, area.dataset.areaDrop);
    });
    this.render();
  }

  disconnectedCallback() {
    if (this._lcarsClockTimer) window.clearInterval(this._lcarsClockTimer);
    this._lcarsClockTimer = null;
  }

  startLcarsClock() {
    if (this._lcarsClockTimer) return;
    this._lcarsClockTimer = window.setInterval(() => this.updateLcarsClock(), 30000);
    this.updateLcarsClock();
  }

  lcarsDateTime() {
    const now = new Date();
    const timeZone = this._hass?.config?.time_zone || undefined;
    return {
      time: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(now),
      date: new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone }).format(now),
    };
  }

  updateLcarsClock() {
    const clock = this.shadowRoot?.querySelector("[data-lcars-clock]");
    const date = this.shadowRoot?.querySelector("[data-lcars-date]");
    if (!clock || !date) return;
    const value = this.lcarsDateTime();
    clock.textContent = value.time;
    date.textContent = value.date;
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: "full", min_columns: 6 }; }
  static getStubConfig() { return { title: "Home topology", show_unassigned: false, show_only_labeled: true }; }

  navigate(path) {
    this.dispatchEvent(new CustomEvent("hass-action", {
      bubbles: true,
      composed: true,
      detail: { config: { tap_action: { action: "navigate", navigation_path: path } }, action: "tap" },
    }));
  }

  collapseTreeProperties() {
    if (this._layoutMode !== "tree" || !this._data) return;
    this._expandedTreeDevices.clear();
  }

  centerWebAfterFilter() {
    if (this._layoutMode === "web") this._centerHomeAfterRender = true;
  }

  openFloorConfig(floorId) {
    const floor = this.effectiveFloors().find((entry) => entry.floor_id === floorId);
    if (!floor || !customElements.get("dialog-floor-registry-detail")) {
      this.navigate("/config/areas");
      return;
    }
    const updateEntry = async (updates, addedAreas, removedAreas) => {
      await this._hass.callWS({ type: "config/floor_registry/update", floor_id: floorId, ...updates });
      await Promise.all([
        ...[...addedAreas].map((areaId) => this._hass.callWS({ type: "config/area_registry/update", area_id: areaId, floor_id: floorId })),
        ...[...removedAreas].map((areaId) => this._hass.callWS({ type: "config/area_registry/update", area_id: areaId, floor_id: null })),
      ]);
      await this.loadRegistries();
    };
    this.dispatchEvent(new CustomEvent("show-dialog", {
      bubbles: true,
      composed: true,
      detail: {
        dialogTag: "dialog-floor-registry-detail",
        dialogImport: async () => {},
        dialogParams: { entry: floor, updateEntry },
      },
    }));
  }

  async assignDeviceToArea(deviceId, areaId) {
    this._assignmentMessage = { type: "working", text: "Assigning device…" };
    this.render();
    try {
      await this._hass.callWS({
        type: "config/device_registry/update",
        device_id: deviceId,
        area_id: areaId,
      });
      this._assignmentMessage = { type: "success", text: "Device assigned" };
      await this.loadRegistries();
    } catch (error) {
      this._assignmentMessage = { type: "error", text: error?.message || "Could not assign device" };
      this.render();
    }
  }

  async toggleEntity(entityId, control) {
    if (!this._hass || control?.classList.contains("working")) return;
    control?.classList.add("working");
    control?.setAttribute("aria-busy", "true");
    try {
      await this._hass.callService("homeassistant", "toggle", {}, { entity_id: entityId });
    } catch (error) {
      console.error(`Could not toggle ${entityId}`, error);
      this.dispatchEvent(new CustomEvent("hass-notification", {
        bubbles: true,
        composed: true,
        detail: { message: error?.message || `Could not toggle ${entityId}` },
      }));
    } finally {
      control?.classList.remove("working");
      control?.removeAttribute("aria-busy");
    }
  }

  async setEntityLevel(entityId, domain, percentage, control) {
    if (!this._hass || !Number.isFinite(percentage)) return;
    control.disabled = true;
    try {
      if (domain === "media_player") {
        await this._hass.callService("media_player", "volume_set", { volume_level: percentage / 100 }, { entity_id: entityId });
      } else if (domain === "light") {
        if (percentage <= 0) await this._hass.callService("light", "turn_off", {}, { entity_id: entityId });
        else await this._hass.callService("light", "turn_on", { brightness_pct: Math.round(percentage) }, { entity_id: entityId });
      }
    } catch (error) {
      console.error(`Could not set ${entityId} level`, error);
      this.dispatchEvent(new CustomEvent("hass-notification", {
        bubbles: true,
        composed: true,
        detail: { message: error?.message || `Could not adjust ${entityId}` },
      }));
    } finally {
      control.disabled = false;
    }
  }

  setZoom(value, clientX, clientY) {
    const nextZoom = Math.round(Math.max(0.65, Math.min(1.8, value)) * 10) / 10;
    if (nextZoom === this.currentScale()) return;
    if (this._layoutMode === "web") this.captureViewportFocus(clientX, clientY);
    if (this._layoutMode === "tree") this._treeScale = nextZoom;
    else this._webZoom = nextZoom;
    this.savePreferences();
    this.render();
  }

  currentScale() {
    return this._layoutMode === "tree" ? this._treeScale : this._webZoom;
  }

  captureViewportFocus(clientX, clientY) {
    const scroller = this.shadowRoot.querySelector(".topology-scroll");
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      const focusX = clientX == null ? scroller.clientWidth / 2 : clientX - rect.left;
      const focusY = clientY == null ? scroller.clientHeight / 2 : clientY - rect.top;
      this._zoomFocus = {
        x: (scroller.scrollLeft + focusX) / scroller.scrollWidth,
        y: (scroller.scrollTop + focusY) / scroller.scrollHeight,
        focusX,
        focusY,
      };
    }
  }

  render() {
    if (!this.shadowRoot || !this._config) return;
    const previousPageScroll = this._standaloneLcars ? this.captureAncestorScroll() : [];
    const oldScroller = this.shadowRoot.querySelector(".topology-scroll");
    const previousScroll = oldScroller ? { left: oldScroller.scrollLeft, top: oldScroller.scrollTop } : null;
    const oldTreeScroller = this.shadowRoot.querySelector(".tree-scroll");
    const previousTreeScroll = oldTreeScroller ? { left: oldTreeScroller.scrollLeft, top: oldTreeScroller.scrollTop } : null;
    const oldUnassignedList = this.shadowRoot.querySelector(".unassigned-list");
    const previousUnassignedScroll = oldUnassignedList?.scrollTop ?? this._unassignedScrollTop ?? null;
    const content = this._loading
      ? '<div class="message"><span class="spinner"></span>Reading Home Assistant registries…</div>'
      : this._error
        ? `<div class="message error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><div><strong>Could not load topology</strong><br>${escapeHtml(this._error)}</div></div>`
        : this._data
          ? (this._layoutMode === "tree" ? this.renderTree() : this._layoutMode === "lcars" ? this.renderLcars() : this.renderAreas())
          : '<div class="message">Waiting for Home Assistant…</div>';

    this.shadowRoot.innerHTML = `
      <style>${this.styles()}</style>
      <ha-card class="${this._standaloneLcars ? "standalone-lcars" : ""}">
        ${this._standaloneLcars ? "" : `<div class="header">
          <div class="header-main">
            <div><h1>Home Topology <span class="version">v${CARD_VERSION} · ${BUILD_COMMIT}</span></h1><p>${this.summary()}</p></div>
            ${this._data ? `<div class="header-actions">
              <div class="layout-controls" aria-label="Topology layout">
                <button class="${this._layoutMode === "web" ? "active" : ""}" data-topology-action="layout-web" title="Spider web layout"><ha-icon icon="mdi:graph-outline"></ha-icon> Web</button>
                <button class="${this._layoutMode === "tree" ? "active" : ""}" data-topology-action="layout-tree" title="Tree layout"><ha-icon icon="mdi:file-tree-outline"></ha-icon> Tree</button>
              </div>
              <button data-topology-action="expand" title="Expand all nodes"><span>＋</span> Expand all</button>
              <button data-topology-action="collapse" title="Collapse to the first hierarchy level"><span>−</span> Collapse all</button>
              <div class="zoom-controls" aria-label="${this._layoutMode === "tree" ? "Tree text size" : "Topology zoom"}">
                <button data-topology-action="zoom-out" title="${this._layoutMode === "tree" ? "Decrease text size" : "Zoom out"}">−</button>
                <button class="zoom-level" data-topology-action="zoom-reset" title="${this._layoutMode === "tree" ? "Reset text size" : "Reset zoom"}">${Math.round(this.currentScale() * 100)}%</button>
                <button data-topology-action="zoom-in" title="${this._layoutMode === "tree" ? "Increase text size" : "Zoom in"}">＋</button>
              </div>
              <button class="toggle-control ${this._labelsOnly ? "active" : ""}" data-topology-action="labels" aria-pressed="${this._labelsOnly}" title="Show only devices with labels"><span class="switch"><i></i></span> Labelled only</button>
              <button class="toggle-control ${this._showUnassigned ? "active" : ""}" data-topology-action="unassigned" aria-pressed="${this._showUnassigned}" title="Show or hide unassigned devices"><span class="switch"><i></i></span> Unassigned</button>
            </div>` : '<ha-icon icon="mdi:graph-outline"></ha-icon>'}
          </div>
          ${this.renderLabelFilters()}
        </div>`}
        <div class="content">${content}</div>
        ${this._standaloneLcars ? this.renderLcarsPopup() : ""}
      </ha-card>`;
    const newScroller = this.shadowRoot.querySelector(".topology-scroll");
    const newTreeScroller = this.shadowRoot.querySelector(".tree-scroll");
    const newUnassignedList = this.shadowRoot.querySelector(".unassigned-list");
    this.configureLcarsHistoryCard();
    this.configureLcarsCameraCards();
    this.configureLcarsEngineeringCards();
    this.configureLcarsCaptainsLogCard();
    this.configureLcarsWeatherCards();
    if (this.shadowRoot.querySelector(".lcars-area-grid")) requestAnimationFrame(() => this.layoutLcarsAreas());
    if (previousPageScroll.length) requestAnimationFrame(() => requestAnimationFrame(() => this.restoreAncestorScroll(previousPageScroll)));
    if (newScroller || newTreeScroller || newUnassignedList) requestAnimationFrame(() => {
      if (newScroller && this._centerHomeAfterRender) {
        newScroller.scrollLeft = Math.max(0, (newScroller.scrollWidth - newScroller.clientWidth) / 2);
        newScroller.scrollTop = Math.max(0, (newScroller.scrollHeight - newScroller.clientHeight) / 2);
        this._centerHomeAfterRender = false;
      } else if (newScroller && this._zoomFocus) {
        newScroller.scrollLeft = this._zoomFocus.x * newScroller.scrollWidth - this._zoomFocus.focusX;
        newScroller.scrollTop = this._zoomFocus.y * newScroller.scrollHeight - this._zoomFocus.focusY;
        this._zoomFocus = null;
      } else if (newScroller && previousScroll) {
        newScroller.scrollLeft = previousScroll.left;
        newScroller.scrollTop = previousScroll.top;
      } else if (newScroller) {
        newScroller.scrollLeft = Math.max(0, (newScroller.scrollWidth - newScroller.clientWidth) / 2);
        newScroller.scrollTop = Math.max(0, (newScroller.scrollHeight - newScroller.clientHeight) / 2);
      }
      if (newUnassignedList && previousUnassignedScroll !== null) {
        newUnassignedList.scrollTop = previousUnassignedScroll;
      }
      if (newTreeScroller && previousTreeScroll) {
        newTreeScroller.scrollLeft = previousTreeScroll.left;
        newTreeScroller.scrollTop = previousTreeScroll.top;
      }
      if (this._restoreUnassignedSearchFocus) {
        const search = this.shadowRoot.querySelector("[data-unassigned-search]");
        search?.focus();
        search?.setSelectionRange(search.value.length, search.value.length);
        this._restoreUnassignedSearchFocus = false;
      }
    });
  }

  captureAncestorScroll() {
    const positions = [];
    const seen = new Set();
    const remember = (element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      if (element.scrollTop || element.scrollLeft || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
        positions.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
    };
    remember(document.scrollingElement);
    let node = this;
    while (node) {
      remember(node);
      node = node.parentNode || node.getRootNode?.()?.host || null;
    }
    return positions;
  }

  restoreAncestorScroll(positions) {
    for (const { element, top, left } of positions) {
      if (!element?.isConnected && element !== document.scrollingElement) continue;
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }

  renderLcarsPopup() {
    if (!this._lcarsPopupEntity) return "";
    const stateObj = this._hass?.states?.[this._lcarsPopupEntity];
    if (!stateObj) return "";
    const name = stateObj.attributes?.friendly_name || this._lcarsPopupEntity;
    const value = this._hass?.formatEntityState?.(stateObj) || stateObj.state;
    return `<div class="lcars-popup-backdrop" data-topology-action="close-lcars-popup">
      <section class="lcars-popup" role="dialog" aria-modal="true" aria-label="${escapeHtml(name)}">
        <div class="lcars-popup-top"><i></i><span>ENTITY ANALYSIS</span><button data-topology-action="close-lcars-popup" title="Close">×</button></div>
        <header><ha-icon icon="${escapeHtml(stateObj.attributes?.icon || "mdi:chart-line")}"></ha-icon><div><small>${escapeHtml(this._lcarsPopupEntity)}</small><h2>${escapeHtml(name)}</h2></div><b data-lcars-popup-value>${escapeHtml(value)}</b></header>
        <div class="lcars-popup-body"><div class="lcars-popup-rail"></div><div class="lcars-history" data-lcars-history></div></div>
        <footer><span></span><b>HISTORY // 24 HOURS</b><i></i></footer>
      </section>
    </div>`;
  }

  async configureLcarsHistoryCard() {
    const host = this.shadowRoot?.querySelector("[data-lcars-history]");
    if (!host || !this._lcarsPopupEntity) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      if (!helpers) throw new Error("Home Assistant card helpers are unavailable");
      if (!host.isConnected || host.firstElementChild) return;
      const chart = await helpers.createCardElement({
        type: "history-graph",
        entities: [this._lcarsPopupEntity],
        hours_to_show: 24,
        show_names: false,
      });
      chart.hass = this._hass;
      host.append(chart);
    } catch (error) {
      console.error("Could not load LCARS history graph", error);
      if (host.isConnected) host.innerHTML = '<div class="lcars-history-error">HISTORY DATA UNAVAILABLE</div>';
    }
  }

  layoutLcarsAreas() {
    const compact = window.matchMedia?.("(max-width: 700px)")?.matches;
    for (const grid of this.shadowRoot?.querySelectorAll(".lcars-area-grid") || []) {
      for (const area of grid.querySelectorAll(":scope > .lcars-area")) {
        area.style.gridRowEnd = "";
        if (!compact) {
          const height = area.getBoundingClientRect().height;
          area.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + 16) / 20))}`;
        }
      }
    }
  }

  summary() {
    if (!this._data) return "Areas and their connected devices";
    const deviceCount = this._data.reduce((total, area) => total + area.devices.length, 0);
    const areaCount = this._data.filter((area) => area.id !== "__unassigned__").length;
    const floorCount = this.effectiveFloors().length;
    const floorSummary = floorCount ? `${floorCount} floor${floorCount === 1 ? "" : "s"} · ` : "";
    return `${floorSummary}${areaCount} area${areaCount === 1 ? "" : "s"} · ${deviceCount} device${deviceCount === 1 ? "" : "s"}`;
  }

  renderLabelFilters() {
    if (!this._labels?.length) return "";
    const allSelected = this._selectedLabels?.size === this._labels.length;
    return `<div class="label-filters" aria-label="Filter devices by label">
      <span class="filter-caption">Labels</span>
      <button class="label-filter all ${allSelected ? "selected" : ""}" data-topology-action="all-labels" aria-pressed="${allSelected}">All</button>
      ${this._labels.map((label) => {
        const selected = this._selectedLabels?.has(label.label_id);
        const color = this.configuredLabelColor(label);
        return `<button class="label-filter ${selected ? "selected" : ""}" data-label-toggle="${escapeHtml(label.label_id)}" aria-pressed="${selected}" style="--label-color:${color};--label-contrast:${contrastColor(color)}">
          ${label.icon ? `<ha-icon icon="${escapeHtml(label.icon)}"></ha-icon>` : ""}<span>${escapeHtml(label.name)}</span>
        </button>`;
      }).join("")}
    </div>`;
  }

  hasFloorLevel() {
    return this.effectiveFloors().length > 1;
  }

  effectiveFloors() {
    const floorsById = new Map((Array.isArray(this._floors) ? this._floors : []).map((floor) => [floor.floor_id, floor]));
    for (const area of this._data || []) {
      if (!area.floorId || floorsById.has(area.floorId)) continue;
      const fallbackName = area.floorId
        .replaceAll("_", " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
      floorsById.set(area.floorId, {
        floor_id: area.floorId,
        name: fallbackName,
        icon: "mdi:layers-outline",
        level: null,
      });
    }
    return [...floorsById.values()];
  }

  floorGroups() {
    const areas = (this._data || []).filter((area) => area.id !== "__unassigned__");
    const groups = this.effectiveFloors().map((floor) => ({
      id: floor.floor_id,
      name: floor.name,
      icon: floor.icon || "mdi:layers-outline",
      level: floor.level,
      areas: areas.filter((area) => area.floorId === floor.floor_id),
    })).sort((a, b) => {
      const groundA = /^ground(?: floor)?$/i.test(a.name.trim()) ? 0 : 1;
      const groundB = /^ground(?: floor)?$/i.test(b.name.trim()) ? 0 : 1;
      return groundA - groundB || (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name);
    });
    const areasWithoutFloor = areas.filter((area) => !groups.some((floor) => floor.id === area.floorId));
    if (areasWithoutFloor.length) groups.push({
      id: "__no_floor__",
      name: "No floor",
      icon: "mdi:layers-off-outline",
      level: null,
      areas: areasWithoutFloor,
    });
    return groups;
  }

  devicesForDisplay(area) {
    const allLabelsSelected = this._selectedLabels?.size === this._labels?.length;
    return area.devices.filter((device) => {
      if (this._labelsOnly && !device.labels.length) return false;
      if (allLabelsSelected) return true;
      return device.labels.some((label) => this._selectedLabels?.has(label.label_id));
    });
  }

  treeDeviceCount(areas) {
    const total = areas.reduce((count, area) => count + area.devices.length, 0);
    const filtered = areas.reduce((count, area) => count + this.devicesForDisplay(area).length, 0);
    return `${total} total device${total === 1 ? "" : "s"} (${filtered} filtered)`;
  }

  renderTree() {
    const areas = this._data.filter((area) => area.id !== "__unassigned__");
    if (!areas.length) return '<div class="message">No areas or devices found.</div>';
    const branches = this.hasFloorLevel()
      ? this.floorGroups().map((floor) => this.renderTreeFloor(floor)).join("")
      : areas.map((area) => this.renderTreeArea(area)).join("");
    const requestedHeight = Number(this._config.map_height);
    const mapHeight = Number.isFinite(requestedHeight) && requestedHeight > 0
      ? `${Math.max(360, Math.min(1400, requestedHeight))}px`
      : "clamp(420px, calc(100vh - 230px), 1200px)";
    const treeScale = this._treeScale;
    return `<div class="workspace" style="--map-height:${mapHeight}"><div class="tree-scroll"><div class="topology-tree" style="--tree-font:${14 * treeScale}px;--tree-small:${11 * treeScale}px;--tree-label:${10 * treeScale}px;--tree-property:${12 * treeScale}px;--tree-id:${10 * treeScale}px">
      <div class="tree-row tree-home">
        <span class="tree-node-icon"><ha-icon icon="mdi:home"></ha-icon></span>
        <div class="tree-copy"><strong>${escapeHtml(this._config.title)}</strong><small>${this.treeDeviceCount(areas)}</small></div>
      </div>
      <div class="tree-children">${branches}</div>
    </div></div>${this.renderUnassignedPanel()}</div>`;
  }

  renderTreeFloor(floor) {
    const collapsed = this._collapsedFloors.has(floor.id);
    const mainAction = floor.id === "__no_floor__"
      ? `data-floor-toggle="${escapeHtml(floor.id)}"`
      : `data-floor-config="${escapeHtml(floor.id)}"`;
    return `<div class="tree-branch tree-floor-branch">
      <div class="tree-row tree-floor">
        <button class="tree-toggle" data-floor-toggle="${escapeHtml(floor.id)}" title="${collapsed ? "Expand" : "Collapse"} ${escapeHtml(floor.name)}">${collapsed ? "+" : "−"}</button>
        <button class="tree-main" ${mainAction} title="${floor.id === "__no_floor__" ? `${collapsed ? "Expand" : "Collapse"} ${escapeHtml(floor.name)}` : `Open ${escapeHtml(floor.name)} settings`}">
          <span class="tree-node-icon"><ha-icon icon="${escapeHtml(floor.icon)}"></ha-icon></span>
          <span class="tree-copy"><strong>${escapeHtml(floor.name)}</strong><small>${floor.areas.length} area${floor.areas.length === 1 ? "" : "s"} · ${this.treeDeviceCount(floor.areas)}</small></span>
        </button>
      </div>
      ${collapsed ? "" : `<div class="tree-children">${floor.areas.map((area) => this.renderTreeArea(area)).join("")}</div>`}
    </div>`;
  }

  renderTreeArea(area) {
    const collapsed = this._collapsedAreas.has(area.id);
    const devices = this.devicesForDisplay(area);
    const hasFilteredDevices = devices.length > 0;
    return `<div class="tree-branch tree-area-branch">
      <div class="tree-row tree-area" data-area-drop="${escapeHtml(area.id)}">
        <button class="tree-toggle ${hasFilteredDevices ? "" : "empty"}" ${hasFilteredDevices ? `data-area-toggle="${escapeHtml(area.id)}" title="${collapsed ? "Expand" : "Collapse"} ${escapeHtml(area.name)}"` : "disabled"}>${hasFilteredDevices ? (collapsed ? "+" : "−") : ""}</button>
        <button class="tree-main" data-area-config="${escapeHtml(area.id)}" title="Open ${escapeHtml(area.name)} settings">
          <span class="tree-node-icon"><ha-icon icon="${escapeHtml(area.icon)}"></ha-icon></span>
          <span class="tree-copy"><strong>${escapeHtml(area.name)}</strong><small>${this.treeDeviceCount([area])}</small></span>
        </button>
      </div>
      ${collapsed || !hasFilteredDevices ? "" : `<div class="tree-children">${devices.map((device) => this.renderTreeDevice(device)).join("")}</div>`}
    </div>`;
  }

  renderTreeDevice(device) {
    const collapsed = !this._expandedTreeDevices.has(device.id);
    const color = safeColor(device.color);
    const metadata = [device.manufacturer, device.model].filter(Boolean).join(" · ");
    const propertyEntities = this._config.tree_show_properties
      ? device.entities.filter((entity) => {
          const stateObj = this._hass?.states?.[entity.entity_id];
          return stateObj
            && String(stateObj.state).toLowerCase() !== "unavailable"
            && !this.isHiddenProperty(entity, stateObj);
        })
      : [];
    const properties = propertyEntities.map((entity) => {
      const stateObj = this._hass?.states?.[entity.entity_id];
      const name = stateObj?.attributes?.friendly_name || entity.name || entity.original_name || entity.entity_id;
      const value = stateObj ? (this._hass?.formatEntityState?.(stateObj) || stateObj.state) : "unavailable";
      const icon = entity.icon || stateObj?.attributes?.icon || "mdi:circle-small";
      return `<button class="tree-property" data-entity="${escapeHtml(entity.entity_id)}" title="Open ${escapeHtml(name)}">
        <ha-icon icon="${escapeHtml(icon)}"></ha-icon><span><b>${escapeHtml(name)}</b><small>${escapeHtml(entity.entity_id)}</small></span><em>${escapeHtml(value)}</em>
      </button>`;
    }).join("");
    return `<div class="tree-branch tree-device-branch" style="--device-color:${color}">
      <div class="tree-row tree-device" draggable="true" data-device-drag="${escapeHtml(device.id)}" data-device="${escapeHtml(device.id)}">
        <button class="tree-toggle ${propertyEntities.length ? "" : "empty"}" ${propertyEntities.length ? `data-device-toggle="${escapeHtml(device.id)}"` : "disabled"} title="${collapsed ? "Expand" : "Collapse"} properties">${propertyEntities.length ? (collapsed ? "+" : "−") : ""}</button>
        <span class="tree-node-icon"><ha-icon icon="${escapeHtml(device.icon)}"></ha-icon></span>
        <span class="tree-copy"><strong>${escapeHtml(device.name)}</strong>${metadata ? `<small>${escapeHtml(metadata)}</small>` : ""}</span>
        ${device.labels.length ? `<span class="tree-labels">${device.labels.map((label) => {
          const labelColor = this.configuredLabelColor(label, color);
          return `<span style="--label-color:${labelColor};--label-contrast:${contrastColor(labelColor)}">${escapeHtml(label.name)}</span>`;
        }).join("")}</span>` : ""}
      </div>
      ${collapsed || !properties ? "" : `<div class="tree-children tree-properties">${properties}</div>`}
    </div>`;
  }

  renderAreas() {
    const visibleAreas = this._data.filter((area) => area.id !== "__unassigned__");
    if (!visibleAreas.length) return '<div class="message">No areas or devices found.</div>';
    if (this.hasFloorLevel()) return this.renderFloorTopology();
    const areaRadius = Math.max(285, visibleAreas.length * 190 / (Math.PI * 2));
    const areaLayouts = [];
    let maximumRadius = areaRadius;
    const allLabelsSelected = this._selectedLabels?.size === this._labels?.length;
    const areaAllocations = visibleAreas.map((area) => {
      const displayedDevices = area.devices.filter((device) => {
        if (this._labelsOnly && !device.labels.length) return false;
        if (allLabelsSelected) return true;
        return device.labels.some((label) => this._selectedLabels?.has(label.label_id));
      });
      const expanded = !this._collapsedAreas.has(area.id);
      return { area, displayedDevices, weight: expanded ? Math.max(1, displayedDevices.length) : 0 };
    });
    const baseArc = Math.min(0.72, Math.PI * 2 / visibleAreas.length);
    const distributableArc = Math.max(0, Math.PI * 2 - baseArc * visibleAreas.length);
    const totalWeight = areaAllocations.reduce((total, allocation) => total + allocation.weight, 0);
    const arcs = areaAllocations.map((allocation) => baseArc + (totalWeight
      ? distributableArc * allocation.weight / totalWeight
      : distributableArc / visibleAreas.length));
    let arcCursor = -Math.PI / 2 - arcs[0] / 2;

    areaAllocations.forEach(({ area, displayedDevices }, areaIndex) => {
      const sector = arcs[areaIndex];
      const angle = arcCursor + sector / 2;
      arcCursor += sector;
      const devices = [];
      if (!this._collapsedAreas.has(area.id)) {
        let deviceIndex = 0;
        let ring = 0;
        while (deviceIndex < displayedDevices.length) {
          const radius = areaRadius + 255 + ring * 190;
          const usableArc = sector * 0.72;
          const capacity = Math.max(1, Math.floor(usableArc * radius / 270) + 1);
          const ringCount = Math.min(capacity, displayedDevices.length - deviceIndex);
          for (let slot = 0; slot < ringCount; slot += 1) {
            const offset = ringCount === 1 ? 0 : (slot / (ringCount - 1) - 0.5) * usableArc;
            devices.push({ device: displayedDevices[deviceIndex], angle: angle + offset, radius });
            deviceIndex += 1;
          }
          maximumRadius = Math.max(maximumRadius, radius);
          ring += 1;
        }
      }
      areaLayouts.push({ area, angle, devices, displayedCount: displayedDevices.length });
    });

    const canvasSize = Math.max(1200, Math.ceil((maximumRadius + 210) * 2));
    const canvas = { width: canvasSize, height: canvasSize };
    const center = { x: canvasSize / 2, y: canvasSize / 2 };
    const areaNodes = [];
    const deviceNodes = [];
    const lines = [];

    areaLayouts.forEach(({ area, angle, devices, displayedCount }) => {
      const areaPoint = {
        x: center.x + Math.cos(angle) * areaRadius,
        y: center.y + Math.sin(angle) * areaRadius,
      };
      lines.push(this.renderLine(center, areaPoint, "area-line"));
      const collapsed = this._collapsedAreas.has(area.id);
      areaNodes.push(`<div class="area node ${collapsed ? "collapsed" : ""}" data-area-drop="${escapeHtml(area.id)}" aria-expanded="${!collapsed}" style="${this.nodeStyle(areaPoint, canvas)}">
        <button class="area-main" data-area-config="${escapeHtml(area.id)}" title="Open ${escapeHtml(area.name)} settings">
          <span class="area-icon"><ha-icon icon="${escapeHtml(area.icon)}"></ha-icon></span>
          <div><h2>${escapeHtml(area.name)}</h2><small>${displayedCount} device${displayedCount === 1 ? "" : "s"}</small></div>
        </button>
        <button class="toggle" data-area-toggle="${escapeHtml(area.id)}" title="${collapsed ? "Expand" : "Collapse"} ${escapeHtml(area.name)}">${collapsed ? "+" : "−"}</button>
      </div>`);

      devices.forEach(({ device, angle: deviceAngle, radius }) => {
        const point = {
          x: center.x + Math.cos(deviceAngle) * radius,
          y: center.y + Math.sin(deviceAngle) * radius,
        };
        lines.push(this.renderLine(areaPoint, point, "device-line", safeColor(device.color)));
        deviceNodes.push(this.renderDevice(device, point, canvas));
      });
    });

    return this.renderTopologyCanvas(canvas, center, lines, [], areaNodes, deviceNodes);
  }

  renderFloorTopology() {
    const floorGroups = this.floorGroups();
    const allLabelsSelected = this._selectedLabels?.size === this._labels?.length;
    const displayedDevices = (area) => area.devices.filter((device) => {
      if (this._labelsOnly && !device.labels.length) return false;
      if (allLabelsSelected) return true;
      return device.labels.some((label) => this._selectedLabels?.has(label.label_id));
    });
    const floorRadius = Math.max(250, floorGroups.length * 200 / (Math.PI * 2));
    const areaCount = floorGroups.reduce((total, floor) => total + floor.areas.length, 0);
    const areaRadius = Math.max(floorRadius + 250, areaCount * 205 / (Math.PI * 2));
    const floorWeights = floorGroups.map((floor) => this._collapsedFloors.has(floor.id) ? 0 : Math.max(1,
      floor.areas.length + floor.areas.reduce((total, area) => total + displayedDevices(area).length, 0) * 0.35));
    const floorBaseArc = Math.min(0.78, Math.PI * 2 / floorGroups.length);
    const floorRemainingArc = Math.max(0, Math.PI * 2 - floorBaseArc * floorGroups.length);
    const totalFloorWeight = floorWeights.reduce((total, weight) => total + weight, 0);
    const floorArcs = floorWeights.map((weight) => floorBaseArc + (totalFloorWeight
      ? floorRemainingArc * weight / totalFloorWeight
      : floorRemainingArc / floorGroups.length));
    let floorCursor = -Math.PI / 2 - floorArcs[0] / 2;
    let maximumRadius = floorRadius;
    const layouts = [];

    floorGroups.forEach((floor, floorIndex) => {
      const floorArc = floorArcs[floorIndex];
      const floorAngle = floorCursor + floorArc / 2;
      floorCursor += floorArc;
      const areas = [];
      if (!this._collapsedFloors.has(floor.id) && floor.areas.length) {
        maximumRadius = Math.max(maximumRadius, areaRadius);
        const usableArc = floorArc * 0.82;
        const areaWeights = floor.areas.map((area) => this._collapsedAreas.has(area.id) ? 0 : Math.max(1, displayedDevices(area).length));
        const areaBaseArc = Math.min(0.58, usableArc / floor.areas.length);
        const areaRemainingArc = Math.max(0, usableArc - areaBaseArc * floor.areas.length);
        const totalAreaWeight = areaWeights.reduce((total, weight) => total + weight, 0);
        const areaArcs = areaWeights.map((weight) => areaBaseArc + (totalAreaWeight
          ? areaRemainingArc * weight / totalAreaWeight
          : areaRemainingArc / floor.areas.length));
        let areaCursor = floorAngle - usableArc / 2;
        floor.areas.forEach((area, areaIndex) => {
          const areaArc = areaArcs[areaIndex];
          const angle = areaCursor + areaArc / 2;
          areaCursor += areaArc;
          const visibleDevices = displayedDevices(area);
          const devices = [];
          if (!this._collapsedAreas.has(area.id)) {
            let deviceIndex = 0;
            let ring = 0;
            while (deviceIndex < visibleDevices.length) {
              const radius = areaRadius + 255 + ring * 190;
              const deviceArc = areaArc * 0.72;
              const capacity = Math.max(1, Math.floor(deviceArc * radius / 270) + 1);
              const ringCount = Math.min(capacity, visibleDevices.length - deviceIndex);
              for (let slot = 0; slot < ringCount; slot += 1) {
                const offset = ringCount === 1 ? 0 : (slot / (ringCount - 1) - 0.5) * deviceArc;
                devices.push({ device: visibleDevices[deviceIndex], angle: angle + offset, radius });
                deviceIndex += 1;
              }
              maximumRadius = Math.max(maximumRadius, radius);
              ring += 1;
            }
          }
          areas.push({ area, angle, devices, displayedCount: visibleDevices.length });
        });
      }
      layouts.push({ floor, angle: floorAngle, areas });
    });

    const canvasSize = Math.max(1200, Math.ceil((maximumRadius + 210) * 2));
    const canvas = { width: canvasSize, height: canvasSize };
    const center = { x: canvasSize / 2, y: canvasSize / 2 };
    const floorNodes = [];
    const areaNodes = [];
    const deviceNodes = [];
    const lines = [];
    layouts.forEach(({ floor, angle, areas }) => {
      const floorPoint = { x: center.x + Math.cos(angle) * floorRadius, y: center.y + Math.sin(angle) * floorRadius };
      const floorCollapsed = this._collapsedFloors.has(floor.id);
      lines.push(this.renderLine(center, floorPoint, "floor-line"));
      const floorMainAction = floor.id === "__no_floor__"
        ? `data-floor-toggle="${escapeHtml(floor.id)}" title="${floorCollapsed ? "Expand" : "Collapse"} ${escapeHtml(floor.name)}"`
        : `data-floor-config="${escapeHtml(floor.id)}" title="Open ${escapeHtml(floor.name)} settings"`;
      floorNodes.push(`<div class="floor node ${floorCollapsed ? "collapsed" : ""}" aria-expanded="${!floorCollapsed}" style="${this.nodeStyle(floorPoint, canvas)}">
        <button class="floor-main" ${floorMainAction}>
          <span class="floor-icon"><ha-icon icon="${escapeHtml(floor.icon)}"></ha-icon></span>
          <div><h2>${escapeHtml(floor.name)}</h2><small>${floor.areas.length} area${floor.areas.length === 1 ? "" : "s"}</small></div>
        </button>
        <button class="toggle" data-floor-toggle="${escapeHtml(floor.id)}" title="${floorCollapsed ? "Expand" : "Collapse"} ${escapeHtml(floor.name)}">${floorCollapsed ? "+" : "−"}</button>
      </div>`);
      areas.forEach(({ area, angle: areaAngle, devices, displayedCount }) => {
        const areaPoint = { x: center.x + Math.cos(areaAngle) * areaRadius, y: center.y + Math.sin(areaAngle) * areaRadius };
        const collapsed = this._collapsedAreas.has(area.id);
        lines.push(this.renderLine(floorPoint, areaPoint, "area-line"));
        areaNodes.push(`<div class="area node ${collapsed ? "collapsed" : ""}" data-area-drop="${escapeHtml(area.id)}" aria-expanded="${!collapsed}" style="${this.nodeStyle(areaPoint, canvas)}">
          <button class="area-main" data-area-config="${escapeHtml(area.id)}" title="Open ${escapeHtml(area.name)} settings">
            <span class="area-icon"><ha-icon icon="${escapeHtml(area.icon)}"></ha-icon></span>
            <div><h2>${escapeHtml(area.name)}</h2><small>${displayedCount} device${displayedCount === 1 ? "" : "s"}</small></div>
          </button>
          <button class="toggle" data-area-toggle="${escapeHtml(area.id)}" title="${collapsed ? "Expand" : "Collapse"} ${escapeHtml(area.name)}">${collapsed ? "+" : "−"}</button>
        </div>`);
        devices.forEach(({ device, angle: deviceAngle, radius }) => {
          const point = { x: center.x + Math.cos(deviceAngle) * radius, y: center.y + Math.sin(deviceAngle) * radius };
          lines.push(this.renderLine(areaPoint, point, "device-line", safeColor(device.color)));
          deviceNodes.push(this.renderDevice(device, point, canvas));
        });
      });
    });
    return this.renderTopologyCanvas(canvas, center, lines, floorNodes, areaNodes, deviceNodes);
  }

  renderTopologyCanvas(canvas, center, lines, floorNodes, areaNodes, deviceNodes) {
    const requestedHeight = Number(this._config.map_height);
    const mapHeight = Number.isFinite(requestedHeight) && requestedHeight > 0
      ? `${Math.max(360, Math.min(1400, requestedHeight))}px`
      : "clamp(420px, calc(100vh - 230px), 1200px)";
    const scaledWidth = Math.round(canvas.width * this._webZoom);
    const scaledHeight = Math.round(canvas.height * this._webZoom);
    return `<div class="workspace" style="--map-height:${mapHeight}"><div class="topology-scroll"><div class="topology-canvas" style="width:${scaledWidth}px;height:${scaledHeight}px"><div class="topology" style="width:${canvas.width}px;height:${canvas.height}px;--zoom:${this._webZoom}">
      <svg class="web" viewBox="0 0 ${canvas.width} ${canvas.height}" preserveAspectRatio="none" aria-hidden="true">
        ${lines.join("")}
      </svg>
      <div class="home node" style="${this.nodeStyle(center, canvas)}">
        <span class="home-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3 2.5 11.1l1.3 1.5L5 11.5V21h5v-6h4v6h5v-9.5l1.2 1.1 1.3-1.5L12 3Zm5 16h-1v-6H8v6H7v-9.2l5-4.3 5 4.3V19Z"/></svg>
        </span>
        <strong>${escapeHtml(this._config.title)}</strong>
      </div>
      ${floorNodes.join("")}
      ${areaNodes.join("")}
      ${deviceNodes.join("")}
    </div></div></div>${this.renderUnassignedPanel()}</div>`;
  }

  renderUnassignedPanel() {
    if (!this._showUnassigned) return "";
    const unassigned = this._data.find((area) => area.id === "__unassigned__");
    const allDevices = unassigned?.devices || [];
    const labelFilteredDevices = this._unassignedLabelsOnly ? allDevices.filter((device) => device.labels.length) : allDevices;
    const query = String(this._unassignedSearch || "").trim().toLowerCase();
    const devices = query ? labelFilteredDevices.filter((device) => [
      device.name,
      device.manufacturer,
      device.model,
      ...device.labels.map((label) => label.name),
    ].some((value) => String(value || "").toLowerCase().includes(query))) : labelFilteredDevices;
    const isFiltered = this._unassignedLabelsOnly || Boolean(query);
    return `<aside class="unassigned-panel">
      <div class="panel-head">
        <div><h2>Unassigned</h2><small>${devices.length}${isFiltered ? ` of ${allDevices.length}` : ""} device${devices.length === 1 ? "" : "s"}</small></div>
        <button class="panel-toggle toggle-control ${this._unassignedLabelsOnly ? "active" : ""}" data-topology-action="unassigned-labels" aria-pressed="${this._unassignedLabelsOnly}" title="Show only labelled unassigned devices"><span class="switch"><i></i></span> Labelled</button>
      </div>
      <label class="panel-search"><ha-icon icon="mdi:magnify"></ha-icon><input type="search" data-unassigned-search value="${escapeHtml(this._unassignedSearch)}" placeholder="Search devices" aria-label="Search unassigned devices"></label>
      <p class="panel-help">Drag a device onto an area to assign it.</p>
      ${this._assignmentMessage ? `<div class="assignment-message ${this._assignmentMessage.type}">${escapeHtml(this._assignmentMessage.text)}</div>` : ""}
      <div class="unassigned-list">
        ${devices.length ? devices.map((device) => this.renderUnassignedDevice(device)).join("") : `<div class="panel-empty">${isFiltered ? "No matching devices" : "No unassigned devices"}</div>`}
      </div>
    </aside>`;
  }

  renderUnassignedDevice(device) {
    const color = safeColor(device.color);
    const hasLabelColor = Boolean(device.color);
    const metadata = [device.manufacturer, device.model].filter(Boolean).join(" · ");
    return `<article class="unassigned-device ${hasLabelColor ? "label-coloured" : ""}" draggable="true" data-unassigned-device="${escapeHtml(device.id)}" style="--device-color:${color}">
      <span class="drag-handle" title="Drag to an area">⋮⋮</span>
      <span class="device-icon"><ha-icon icon="${escapeHtml(device.icon)}"></ha-icon></span>
      <button data-device="${escapeHtml(device.id)}" title="Open ${escapeHtml(device.name)} settings">
        <strong>${escapeHtml(device.name)}</strong>${metadata ? `<small>${escapeHtml(metadata)}</small>` : ""}
        ${device.labels.length ? `<span class="panel-labels">${device.labels.map((label) => {
          const labelColor = this.configuredLabelColor(label, color);
          return `<span style="--label-color:${labelColor};--label-contrast:${contrastColor(labelColor)}">${escapeHtml(label.name)}</span>`;
        }).join("")}</span>` : ""}
      </button>
    </article>`;
  }

  renderLine(from, to, className, color = "") {
    const style = color ? ` style="--line-color:${color}"` : "";
    return `<line class="${className}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"${style}/>`;
  }

  renderLcars() {
    const areas = (this._data || []).filter((area) => area.id !== "__unassigned__");
    const groups = this.hasFloorLevel()
      ? this.floorGroups()
      : [{ id: "__home__", name: this._config.title, icon: "mdi:home", areas }];
    const visibleGroups = this.orderConfiguredItems("floors", groups, (group) => group.id, (group) => group.name)
      .filter((group) => !this._standaloneLcars || this.matchesConfiguredItem("floors", group.id, group.name))
      .map((group) => ({
      ...group,
      areas: this.orderConfiguredItems("areas", group.areas, (area) => area.id, (area) => area.name)
        .filter((area) => !this._standaloneLcars || this.matchesConfiguredItem("areas", area.id, area.name))
        .map((area) => ({ ...area, displayDevices: this.devicesForDisplay(area) }))
        .filter((area) => area.displayDevices.length > 0),
    })).filter((group) => group.areas.length > 0);
    const floorViews = visibleGroups.map((group, index) => {
      const color = this.configuredItemColor("floor_colors", group.id, group.name, ["#cc99cc", "#ff9966", "#ffcc99", "#9999ff"][index % 4]);
      return { ...group, color, contrast: contrastColor(color), number: String(index + 1).padStart(2, "0") };
    });
    const selectedFloorId = this._standaloneLcars
      ? (floorViews.some((group) => group.id === this._lcarsSelectedFloor) ? this._lcarsSelectedFloor : floorViews[0]?.id)
      : null;
    if (this._standaloneLcars) this._lcarsSelectedFloor = selectedFloorId;
    const weatherConfig = this._standaloneLcars && this._config.weather?.entity ? this._config.weather : null;
    const weatherSelected = Boolean(weatherConfig && this._lcarsSelectedView === "weather");
    const securityConfig = this._standaloneLcars && Array.isArray(this._config.security?.cameras) && this._config.security.cameras.length ? this._config.security : null;
    const securitySelected = Boolean(securityConfig && this._lcarsSelectedView === "security");
    const engineeringConfig = this._standaloneLcars && ((Array.isArray(this._config.engineering?.panels) && this._config.engineering.panels.length) || (Array.isArray(this._config.engineering?.metrics) && this._config.engineering.metrics.length)) ? this._config.engineering : null;
    const engineeringSelected = Boolean(engineeringConfig && this._lcarsSelectedView === "engineering");
    const captainsLogConfig = this._standaloneLcars && Array.isArray(this._config.captains_log?.entities) && this._config.captains_log.entities.length ? this._config.captains_log : null;
    const captainsLogSelected = Boolean(captainsLogConfig && this._lcarsSelectedView === "captains_log");
    const customMenus = this._standaloneLcars && Array.isArray(this._config.menus)
      ? this._config.menus.filter((menu) => menu?.id && menu?.title).map((menu, index) => ({ ...menu, color: safeColor(menu.color, ["#cc99cc", "#66aacc", "#ffcc99", "#9999ff"][index % 4]) }))
      : [];
    const selectedCustomMenu = customMenus.find((menu) => this._lcarsSelectedView === `menu:${menu.id}`) || null;
    const displayedFloorViews = this._standaloneLcars
      ? floorViews.filter((group) => !weatherSelected && !securitySelected && !engineeringSelected && !captainsLogSelected && !selectedCustomMenu && group.id === selectedFloorId)
      : floorViews;
    const weatherColor = safeColor(weatherConfig?.color, "#66aacc");
    const securityColor = safeColor(securityConfig?.color, "#cc6677");
    const engineeringColor = safeColor(engineeringConfig?.color, "#ff9966");
    const captainsLogColor = safeColor(captainsLogConfig?.color, "#c090b8");
    const footerColor = weatherSelected ? weatherColor : (securitySelected ? securityColor : (engineeringSelected ? engineeringColor : (captainsLogSelected ? captainsLogColor : (selectedCustomMenu?.color || displayedFloorViews[0]?.color || "#cc99cc"))));
    const dateTime = this.lcarsDateTime();
    const headerColor = safeColor(this._config.header_color, "#263f4b");
    const dateTimeColor = safeColor(this._config.datetime_color, "#ff9900");
    return `<div class="lcars-dashboard" style="--lcars-header:${headerColor};--lcars-header-contrast:${contrastColor(headerColor)};--lcars-datetime:${dateTimeColor}">
      <div class="lcars-masthead">
        <div class="lcars-cap"></div><div class="lcars-title"><strong>${escapeHtml(this._config.title)}</strong></div><div class="lcars-clock" data-lcars-clock>${escapeHtml(dateTime.time)}</div><div class="lcars-date" data-lcars-date>${escapeHtml(dateTime.date)}</div><div class="lcars-end"></div>
      </div>
      ${floorViews.length || weatherConfig || securityConfig || engineeringConfig || captainsLogConfig || customMenus.length ? `${this._standaloneLcars ? `<div class="lcars-body">
        <nav class="lcars-floor-nav" aria-label="Floor navigation">
          <div class="lcars-nav-cap"></div>
          ${floorViews.map((group) => `<button class="${!weatherSelected && !securitySelected && !engineeringSelected && !captainsLogSelected && !selectedCustomMenu && group.id === selectedFloorId ? "active" : ""}" data-floor-nav="${escapeHtml(group.id)}" aria-pressed="${!weatherSelected && !securitySelected && !engineeringSelected && !captainsLogSelected && !selectedCustomMenu && group.id === selectedFloorId}" style="--nav-color:${group.color};--nav-contrast:${group.contrast}" title="Show ${escapeHtml(group.name)}"><span>${group.number}</span><b>${escapeHtml(group.name)}</b></button>`).join("")}
          ${weatherConfig ? `<button class="${weatherSelected ? "active" : ""}" data-floor-nav="__weather__" aria-pressed="${weatherSelected}" style="--nav-color:${weatherColor};--nav-contrast:${contrastColor(weatherColor)}" title="Show weather"><span>${String(floorViews.length + 1).padStart(2, "0")}</span><b>WEATHER</b></button>` : ""}
          ${securityConfig ? `<button class="${securitySelected ? "active" : ""}" data-floor-nav="__security__" aria-pressed="${securitySelected}" style="--nav-color:${securityColor};--nav-contrast:${contrastColor(securityColor)}" title="Show security cameras"><span>${String(floorViews.length + (weatherConfig ? 2 : 1)).padStart(2, "0")}</span><b>SECURITY</b></button>` : ""}
          ${engineeringConfig ? `<button class="${engineeringSelected ? "active" : ""}" data-floor-nav="__engineering__" aria-pressed="${engineeringSelected}" style="--nav-color:${engineeringColor};--nav-contrast:#fff" title="Show engineering systems"><span>${String(floorViews.length + 1 + (weatherConfig ? 1 : 0) + (securityConfig ? 1 : 0)).padStart(2, "0")}</span><b>ENGINEERING</b></button>` : ""}
          ${captainsLogConfig ? `<button class="${captainsLogSelected ? "active" : ""}" data-floor-nav="__captains_log__" aria-pressed="${captainsLogSelected}" style="--nav-color:${captainsLogColor};--nav-contrast:${contrastColor(captainsLogColor)}" title="Show Captain's Log"><span>${String(floorViews.length + 1 + (weatherConfig ? 1 : 0) + (securityConfig ? 1 : 0) + (engineeringConfig ? 1 : 0)).padStart(2, "0")}</span><b>CAPTAIN'S LOG</b></button>` : ""}
          ${customMenus.map((menu, index) => `<button class="${selectedCustomMenu?.id === menu.id ? "active" : ""}" data-floor-nav="__menu_${escapeHtml(menu.id)}__" aria-pressed="${selectedCustomMenu?.id === menu.id}" style="--nav-color:${menu.color};--nav-contrast:${contrastColor(menu.color)}" title="Show ${escapeHtml(menu.title)}"><span>${String(floorViews.length + 1 + (weatherConfig ? 1 : 0) + (securityConfig ? 1 : 0) + (engineeringConfig ? 1 : 0) + (captainsLogConfig ? 1 : 0) + index).padStart(2, "0")}</span><b>${escapeHtml(menu.title)}</b></button>`).join("")}
          <div class="lcars-nav-foot"></div>
        </nav>
        <main class="lcars-main">` : ""}${weatherSelected ? this.renderLcarsWeather(weatherConfig, weatherColor) : securitySelected ? this.renderLcarsSecurity(securityConfig, securityColor) : engineeringSelected ? this.renderLcarsEngineering(engineeringConfig, engineeringColor) : captainsLogSelected ? this.renderLcarsCaptainsLog(captainsLogConfig, captainsLogColor) : selectedCustomMenu ? this.renderLcarsCustomMenu(selectedCustomMenu) : displayedFloorViews.map((group, index) => {
        const floorStyle = ` style="--lcars-tone:${group.color};--lcars-tone-contrast:${group.contrast}"`;
        return `<section class="lcars-floor lcars-tone-${index % 4}" data-lcars-floor="${escapeHtml(group.id)}"${floorStyle}>
          <header><button ${group.id === "__home__" || group.id === "__no_floor__" ? "" : `data-floor-config="${escapeHtml(group.id)}"`}><ha-icon icon="${escapeHtml(group.icon || "mdi:layers-outline")}"></ha-icon>${escapeHtml(group.name)}</button><i></i><b>${group.areas.length} SECTOR${group.areas.length === 1 ? "" : "S"}</b></header>
          <div class="lcars-area-grid">${group.areas.map((area) => this.renderLcarsArea(area)).join("")}${this.renderLcarsFloorCameras(group, securityConfig)}</div>
        </section>`;
      }).join("")}<div class="lcars-footer" style="--lcars-footer-tone:${footerColor}"><span></span><b>VERSION ${CARD_VERSION} // BUILD ${BUILD_COMMIT}</b><i></i></div>${this._standaloneLcars ? "</main></div>" : ""}` : `<div class="lcars-empty">NO MATCHING SYSTEMS</div>`}
    </div>`;
  }

  async loadLcarsWeatherForecast() {
    const entityId = this._config?.weather?.entity;
    if (!entityId || this._weatherForecastEntity === entityId) return;
    this._weatherForecastEntity = entityId;
    try {
      const getForecast = async (type) => {
        const result = await this._hass.callWS({ type: "call_service", domain: "weather", service: "get_forecasts", service_data: { type }, target: { entity_id: entityId }, return_response: true });
        const response = result?.response || result;
        return response?.[entityId]?.forecast || response?.forecast || [];
      };
      const [daily, hourly] = await Promise.all([getForecast("daily"), getForecast("hourly")]);
      this._weatherForecast = { daily, hourly };
      if (this._lcarsSelectedView === "weather") this.render();
    } catch (error) {
      console.warn("Could not load LCARS weather forecast", error);
      this._weatherForecast = { daily: [], hourly: [] };
    }
  }

  renderLcarsWeather(config, color) {
    const weather = this._hass?.states?.[config.entity];
    if (!weather) return '<section class="lcars-weather-empty">WEATHER SYSTEM UNAVAILABLE</section>';
    const sensorValue = (entityId, fallback = "—") => {
      const stateObj = entityId ? this._hass?.states?.[entityId] : null;
      return stateObj && !["unknown", "unavailable"].includes(stateObj.state) ? stateObj.state : fallback;
    };
    const temperature = sensorValue(config.temperature_sensor, weather.attributes?.temperature ?? "—");
    const humidity = sensorValue(config.humidity_sensor, weather.attributes?.humidity ?? "—");
    const apparent = sensorValue(config.apparent_sensor);
    const aqi = sensorValue(config.aqi_sensor);
    const wind = sensorValue(config.wind_speed_sensor, weather.attributes?.wind_speed ?? "—");
    const gusts = sensorValue(config.wind_gust_sensor, weather.attributes?.wind_gust_speed ?? "—");
    const hourlyRain = sensorValue(config.hourly_rain_sensor, weather.attributes?.precipitation ?? "—");
    const dewPoint = sensorValue(config.dew_point_sensor, weather.attributes?.dew_point ?? "—");
    const uvIndex = sensorValue(config.uv_index_sensor, weather.attributes?.uv_index ?? "—");
    const pressure = sensorValue(config.pressure_sensor, weather.attributes?.pressure ?? "—");
    const windUnit = weather.attributes?.wind_speed_unit || "km/h";
    const rainUnit = weather.attributes?.precipitation_unit || "mm/h";
    const pressureUnit = weather.attributes?.pressure_unit || "hPa";
    const sun = config.sun_entity ? this._hass?.states?.[config.sun_entity] : null;
    const formatSunTime = (value) => value ? new Intl.DateTimeFormat(config.locale || "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: this._hass?.config?.time_zone }).format(new Date(value)) : null;
    const sunrise = formatSunTime(sun?.attributes?.next_rising);
    const sunset = formatSunTime(sun?.attributes?.next_setting);
    const daily = (this._weatherForecast?.daily?.length ? this._weatherForecast.daily : (weather.attributes?.forecast || [])).slice(0, Number(config.forecast_rows) || 10);
    const hourly = (this._weatherForecast?.hourly || []).slice(0, Number(config.hourly_rows) || 8);
    const conditionIcon = (condition) => ({ sunny: "mdi:weather-sunny", clear: "mdi:weather-night", cloudy: "mdi:weather-cloudy", partlycloudy: "mdi:weather-partly-cloudy", rainy: "mdi:weather-rainy", pouring: "mdi:weather-pouring", snowy: "mdi:weather-snowy", fog: "mdi:weather-fog", lightning: "mdi:weather-lightning" }[condition] || "mdi:weather-cloudy");
    return `<section class="lcars-weather" style="--weather-tone:${color};--weather-contrast:${contrastColor(color)}">
      <header><ha-icon icon="mdi:weather-partly-cloudy"></ha-icon><strong>WEATHER</strong><i></i><b>${escapeHtml(String(weather.state).replaceAll("_", " "))}</b></header>
      <div class="lcars-weather-grid">
        <div class="lcars-weather-current">
        <ha-icon class="weather-main-icon ${weather.state === "sunny" ? "weather-sun" : ""}" icon="${conditionIcon(weather.state)}"></ha-icon>
          <div><small>CURRENT CONDITIONS</small><strong>${escapeHtml(temperature)}°C</strong><span>${escapeHtml(String(weather.state).replaceAll("_", " "))}</span></div>
          <dl><div><dt><ha-icon icon="mdi:water-percent"></ha-icon>HUMIDITY</dt><dd>${escapeHtml(humidity)}%</dd></div>${apparent !== "—" ? `<div><dt><ha-icon icon="mdi:thermometer-lines"></ha-icon>FEELS LIKE</dt><dd>${escapeHtml(apparent)}°C</dd></div>` : ""}${wind !== "—" ? `<div><dt><ha-icon icon="mdi:weather-windy"></ha-icon>WIND</dt><dd>${escapeHtml(wind)} ${escapeHtml(windUnit)}</dd></div>` : ""}${gusts !== "—" ? `<div><dt><ha-icon icon="mdi:weather-windy-variant"></ha-icon>MAX GUSTS</dt><dd>${escapeHtml(gusts)} ${escapeHtml(windUnit)}</dd></div>` : ""}${hourlyRain !== "—" ? `<div><dt><ha-icon icon="mdi:weather-pouring"></ha-icon>HOURLY RAIN</dt><dd>${escapeHtml(hourlyRain)} ${escapeHtml(rainUnit)}</dd></div>` : ""}${dewPoint !== "—" ? `<div><dt><ha-icon icon="mdi:thermometer-water"></ha-icon>DEW POINT</dt><dd>${escapeHtml(dewPoint)}°C</dd></div>` : ""}${uvIndex !== "—" ? `<div><dt><ha-icon icon="mdi:weather-sunny-alert"></ha-icon>UV INDEX</dt><dd>${escapeHtml(uvIndex)}</dd></div>` : ""}${pressure !== "—" ? `<div><dt><ha-icon icon="mdi:gauge"></ha-icon>PRESSURE</dt><dd>${escapeHtml(pressure)} ${escapeHtml(pressureUnit)}</dd></div>` : ""}${aqi !== "—" ? `<div><dt><ha-icon icon="mdi:air-filter"></ha-icon>AIR QUALITY</dt><dd>${escapeHtml(aqi)}</dd></div>` : ""}${sunrise ? `<div><dt><ha-icon icon="mdi:weather-sunset-up"></ha-icon>SUNRISE</dt><dd>${escapeHtml(sunrise)}</dd></div>` : ""}${sunset ? `<div><dt><ha-icon icon="mdi:weather-sunset-down"></ha-icon>SUNSET</dt><dd>${escapeHtml(sunset)}</dd></div>` : ""}</dl>
        </div>
        <div class="lcars-weather-panels">
          ${this.renderLcarsForecastPanel("DAILY", daily, false, config, conditionIcon)}
          ${this.renderLcarsForecastPanel("HOURLY", hourly, true, config, conditionIcon)}
        </div>
        ${Array.isArray(config.panels) && config.panels.length ? `<div class="lcars-weather-history-panels">${config.panels.map((panel, index) => `<section class="lcars-weather-history-panel"><header><ha-icon icon="${escapeHtml(panel.icon || "mdi:chart-line")}"></ha-icon><strong>${escapeHtml(panel.title || `WEATHER HISTORY ${index + 1}`)}</strong></header><div class="lcars-weather-history-card" data-lcars-weather-panel="${index}"></div></section>`).join("")}</div>` : ""}
      </div>
    </section>`;
  }

  async configureLcarsWeatherCards() {
    const hosts = [...(this.shadowRoot?.querySelectorAll("[data-lcars-weather-panel]") || [])];
    if (!hosts.length) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      if (!helpers) throw new Error("Home Assistant card helpers are unavailable");
      for (const host of hosts) {
        if (!host.isConnected || host.firstElementChild) continue;
        const panel = this._config.weather?.panels?.[Number(host.dataset.lcarsWeatherPanel)];
        if (!panel) continue;
        const { title: _title, icon: _icon, ...cardConfig } = panel;
        const card = await helpers.createCardElement(cardConfig);
        card.hass = this._hass;
        host.append(card);
      }
    } catch (error) {
      console.error("Could not load LCARS weather history cards", error);
      for (const host of hosts) if (host.isConnected && !host.firstElementChild) host.innerHTML = '<div class="lcars-weather-history-error">WEATHER HISTORY UNAVAILABLE</div>';
    }
  }

  renderLcarsForecastPanel(title, forecast, hourly, config, conditionIcon) {
    const temperatures = forecast.flatMap((entry) => [Number(entry.templow ?? entry.temperature), Number(entry.temperature)]).filter(Number.isFinite);
    const minScale = temperatures.length ? Math.min(...temperatures) : 0;
    const maxScale = temperatures.length ? Math.max(...temperatures) : 30;
    const range = Math.max(1, maxScale - minScale);
    const temperatureColor = (temperature) => {
      if (!Number.isFinite(temperature)) return "#66aacc";
      const stops = [[0, [18, 58, 140]], [12, [42, 112, 210]], [20, [239, 139, 44]], [25, [211, 47, 47]], [30, [127, 0, 0]]];
      if (temperature <= stops[0][0]) return `rgb(${stops[0][1].join(",")})`;
      if (temperature >= stops.at(-1)[0]) return `rgb(${stops.at(-1)[1].join(",")})`;
      const upperIndex = stops.findIndex(([value]) => temperature <= value);
      const [lowValue, lowColor] = stops[upperIndex - 1];
      const [highValue, highColor] = stops[upperIndex];
      const ratio = (temperature - lowValue) / (highValue - lowValue);
      return `rgb(${lowColor.map((channel, index) => Math.round(channel + (highColor[index] - channel) * ratio)).join(",")})`;
    };
    const rows = forecast.map((entry) => {
      const date = new Date(entry.datetime || entry.date || Date.now());
      const label = new Intl.DateTimeFormat(config.locale || "en-GB", hourly ? { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: this._hass?.config?.time_zone } : { weekday: "short", timeZone: this._hass?.config?.time_zone }).format(date);
      const low = Number(entry.templow ?? entry.temperature);
      const high = Number(entry.temperature);
      const start = Number.isFinite(low) ? ((low - minScale) / range) * 100 : 0;
      const end = Number.isFinite(high) ? ((high - minScale) / range) * 100 : start;
      return `<div class="lcars-forecast-row"><b>${escapeHtml(label)}</b><ha-icon class="${entry.condition === "sunny" ? "weather-sun" : ""}" icon="${conditionIcon(entry.condition)}"></ha-icon><span>${Number.isFinite(low) ? `${low.toFixed(config.show_decimal === false ? 0 : 1)}°` : "—"}</span><i style="--forecast-start:${start}%;--forecast-end:${Math.max(start + 4, end)}%;--forecast-start-color:${temperatureColor(low)};--forecast-end-color:${temperatureColor(high)}"></i><em>${Number.isFinite(high) ? `${high.toFixed(config.show_decimal === false ? 0 : 1)}°` : "—"}</em></div>`;
    }).join("");
    return `<section class="lcars-weather-panel"><header><ha-icon icon="${hourly ? "mdi:clock-outline" : "mdi:calendar-range"}"></ha-icon><strong>${title}</strong></header><div>${rows || '<div class="lcars-weather-no-forecast">FORECAST DATA UNAVAILABLE</div>'}</div></section>`;
  }

  renderLcarsSecurity(config, color) {
    const cameras = config.cameras.filter((camera) => camera?.entity);
    return `<section class="lcars-security" style="--security-tone:${color};--security-contrast:${contrastColor(color)}">
      <header><ha-icon icon="mdi:cctv"></ha-icon><strong>SECURITY</strong><i></i><b>${cameras.length} CAMERA${cameras.length === 1 ? "" : "S"}</b></header>
      <div class="lcars-security-grid"><div class="lcars-camera-grid">${cameras.map((camera) => {
        const stateObj = this._hass?.states?.[camera.entity];
        const name = camera.name || stateObj?.attributes?.friendly_name || camera.entity;
        return `<article class="lcars-camera-panel"><header><ha-icon icon="${escapeHtml(stateObj?.attributes?.icon || "mdi:cctv")}"></ha-icon><strong>${escapeHtml(name)}</strong>${camera.show_state === false ? "" : `<b data-camera-state="${escapeHtml(camera.entity)}">${escapeHtml(stateObj?.state || "unavailable")}</b>`}</header><div class="lcars-camera-card" data-lcars-camera="${escapeHtml(camera.entity)}"></div></article>`;
      }).join("")}</div></div>
    </section>`;
  }

  renderLcarsFloorCameras(group, securityConfig) {
    if (!securityConfig?.cameras?.length) return "";
    const matchesFloor = (camera) => {
      const target = String(camera.show_on_floor || "").trim().toLowerCase();
      return target && [group.id, group.name].some((value) => String(value || "").trim().toLowerCase() === target);
    };
    return securityConfig.cameras.filter(matchesFloor).map((camera) => {
      const stateObj = this._hass?.states?.[camera.entity];
      const name = camera.name || stateObj?.attributes?.friendly_name || camera.entity;
      return `<article class="lcars-area lcars-floor-camera">
        <header><button><ha-icon icon="${escapeHtml(stateObj?.attributes?.icon || "mdi:cctv")}"></ha-icon><strong>${escapeHtml(name)}</strong></button>${camera.show_state === false ? "" : `<b class="lcars-floor-camera-state" data-camera-state="${escapeHtml(camera.entity)}">${escapeHtml(stateObj?.state || "unavailable")}</b>`}</header>
        <div class="lcars-floor-camera-card lcars-camera-card" data-lcars-camera="${escapeHtml(camera.entity)}"></div>
      </article>`;
    }).join("");
  }

  async configureLcarsCameraCards() {
    const hosts = [...(this.shadowRoot?.querySelectorAll("[data-lcars-camera]") || [])];
    if (!hosts.length) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      if (!helpers) throw new Error("Home Assistant card helpers are unavailable");
      for (const host of hosts) {
        if (!host.isConnected || host.firstElementChild) continue;
        const camera = this._config.security.cameras.find((entry) => entry.entity === host.dataset.lcarsCamera);
        if (!camera) continue;
        const card = await helpers.createCardElement({
          type: "picture-entity",
          entity: camera.entity,
          camera_image: camera.camera_image || camera.entity,
          camera_view: camera.camera_view || "auto",
          fit_mode: camera.fit_mode || "cover",
          name: camera.name,
          show_name: false,
          show_state: false,
        });
        card.hass = this._hass;
        host.append(card);
      }
    } catch (error) {
      console.error("Could not load LCARS camera cards", error);
      for (const host of hosts) if (host.isConnected && !host.firstElementChild) host.innerHTML = '<div class="lcars-camera-error">CAMERA FEED UNAVAILABLE</div>';
    }
  }

  renderLcarsEngineering(config, color) {
    const metrics = Array.isArray(config.metrics) ? config.metrics : [];
    const panels = Array.isArray(config.panels) ? config.panels : [];
    const chartColor = safeColor(config.chart_color, color);
    const chartSecondary = safeColor(config.chart_secondary_color, "#9999ff");
    const chartTertiary = safeColor(config.chart_tertiary_color, "#ffcc99");
    return `<section class="lcars-engineering" style="--engineering-tone:${color};--engineering-contrast:#fff;--engineering-chart:${chartColor};--engineering-chart-secondary:${chartSecondary};--engineering-chart-tertiary:${chartTertiary}">
      <header><ha-icon icon="mdi:engine-outline"></ha-icon><strong>ENGINEERING</strong><i></i><b>${panels.length} SYSTEM${panels.length === 1 ? "" : "S"}</b></header>
      <div class="lcars-engineering-grid">
        ${metrics.length ? `<div class="lcars-engineering-metrics">${metrics.map((metric, index) => `<article><ha-icon icon="${escapeHtml(metric.icon || "mdi:flash")}"></ha-icon><div><strong>${escapeHtml(metric.name || `METRIC ${index + 1}`)}</strong><span data-engineering-metric="${index}">${escapeHtml(this.engineeringMetricValue(metric))}</span></div></article>`).join("")}</div>` : ""}
        <div class="lcars-engineering-panels">${panels.map((panel, index) => `<article class="lcars-engineering-panel"><header><ha-icon icon="${escapeHtml(panel.icon || "mdi:lightning-bolt")}"></ha-icon><strong>${escapeHtml(panel.title || `SYSTEM ${index + 1}`)}</strong></header><div class="lcars-engineering-card" data-lcars-engineering="${index}"></div></article>`).join("")}</div>
      </div>
    </section>`;
  }

  engineeringMetricValue(metric) {
    const stateObj = this._hass?.states?.[metric.entity];
    if (!stateObj || ["unknown", "unavailable"].includes(stateObj.state)) return "UNAVAILABLE";
    const value = metric.use_formatted_state === false ? stateObj.state : (this._hass?.formatEntityState?.(stateObj) || stateObj.state);
    return `${metric.prefix || ""}${value}${metric.suffix || ""}`;
  }

  async configureLcarsEngineeringCards() {
    const hosts = [...(this.shadowRoot?.querySelectorAll("[data-lcars-engineering]") || [])];
    if (!hosts.length) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      if (!helpers) throw new Error("Home Assistant card helpers are unavailable");
      for (const host of hosts) {
        if (!host.isConnected || host.firstElementChild) continue;
        const panel = this._config.engineering?.panels?.[Number(host.dataset.lcarsEngineering)];
        if (!panel) continue;
        const { title: _title, icon: _icon, ...cardConfig } = panel;
        const card = await helpers.createCardElement(cardConfig);
        card.hass = this._hass;
        host.append(card);
      }
    } catch (error) {
      console.error("Could not load LCARS engineering cards", error);
      for (const host of hosts) if (host.isConnected && !host.firstElementChild) host.innerHTML = '<div class="lcars-engineering-error">ENGINEERING DATA UNAVAILABLE</div>';
    }
  }

  renderLcarsCaptainsLog(config, color) {
    return `<section class="lcars-engineering lcars-captains-log" style="--engineering-tone:${color};--engineering-contrast:${contrastColor(color)};--engineering-chart:${color};--engineering-chart-secondary:#9999ff;--engineering-chart-tertiary:#ffcc99">
      <header><ha-icon icon="mdi:notebook-edit-outline"></ha-icon><strong>CAPTAIN'S LOG</strong><i></i><b>1 SECTOR</b></header>
      <div class="lcars-engineering-grid">
        <div class="lcars-engineering-panels"><article class="lcars-engineering-panel"><header><ha-icon icon="mdi:calendar-month"></ha-icon><strong>CALENDAR</strong></header><div class="lcars-engineering-card lcars-captains-log-card" data-lcars-captains-log></div></article></div>
      </div>
    </section>`;
  }

  async configureLcarsCaptainsLogCard() {
    const host = this.shadowRoot?.querySelector("[data-lcars-captains-log]");
    if (!host || host.firstElementChild) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      if (!helpers) throw new Error("Home Assistant card helpers are unavailable");
      const config = this._config.captains_log;
      const card = await helpers.createCardElement({
        type: "calendar",
        entities: config.entities,
        initial_view: config.initial_view,
      });
      card.hass = this._hass;
      host.append(card);
      this.styleLcarsCalendar(card, safeColor(config.color, "#c090b8"));
    } catch (error) {
      console.error("Could not load LCARS Captain's Log calendar", error);
      if (host.isConnected) host.innerHTML = '<div class="lcars-engineering-error">CALENDAR DATA UNAVAILABLE</div>';
    }
  }

  styleLcarsCalendar(card, color) {
    const contrast = contrastColor(color);
    const css = `
      :host { --primary-color:${color}; --accent-color:${color}; --state-icon-color:${color}; --mdc-theme-primary:${color}; font-family:Impact,"Arial Narrow",sans-serif!important; }
      ha-card,.card-content,.fc { color:#f5f1ff!important; background:#050507!important; font-family:Impact,"Arial Narrow",sans-serif!important; letter-spacing:.025em; }
      .fc .fc-toolbar { gap:14px; padding:14px 16px; background:#0b0b10; }
      .fc .fc-toolbar-title { color:#f5f1ff; font-family:Impact,"Arial Narrow",sans-serif!important; font-size:30px!important; font-weight:400!important; letter-spacing:.045em; text-transform:uppercase; }
      .fc .fc-button,.fc .fc-button-primary,.fc .fc-today-button,button,mwc-button,ha-button { min-height:38px; border:0!important; border-radius:20px!important; color:${contrast}!important; background:${color}!important; box-shadow:none!important; font-family:Impact,"Arial Narrow",sans-serif!important; font-size:15px!important; font-weight:400!important; letter-spacing:.05em!important; text-transform:uppercase; }
      .fc .fc-button:hover,.fc .fc-button:focus,.fc .fc-button-active { filter:brightness(1.14); }
      .fc .fc-button-group { gap:4px; }
      .fc .fc-button-group>.fc-button { border-radius:0!important; }
      .fc .fc-button-group>.fc-button:first-child { border-radius:20px 0 0 20px!important; }
      .fc .fc-button-group>.fc-button:last-child { border-radius:0 20px 20px 0!important; }
      .fc .fc-scrollgrid { overflow:hidden; border:2px solid ${color}!important; border-radius:0 22px 22px 0; }
      .fc-theme-standard td,.fc-theme-standard th { border-color:color-mix(in srgb,${color} 38%,#27222e)!important; }
      .fc .fc-col-header-cell { color:${contrast}; background:${color}; }
      .fc .fc-col-header-cell-cushion { padding:9px 6px!important; color:${contrast}!important; font-family:Impact,"Arial Narrow",sans-serif!important; font-size:15px; font-weight:400; letter-spacing:.05em; text-transform:uppercase; }
      .fc .fc-daygrid-day-number,.fc .fc-list-day-text,.fc .fc-list-day-side-text,.fc .fc-timegrid-slot-label { color:#f5f1ff!important; font-family:Impact,"Arial Narrow",sans-serif!important; font-size:15px; letter-spacing:.035em; }
      .fc .fc-day-today { background:color-mix(in srgb,${color} 18%,#09090d)!important; }
      .fc .fc-day-today .fc-daygrid-day-number { display:inline-grid; place-items:center; min-width:32px; min-height:32px; border-radius:50%; color:${contrast}!important; background:${color}; }
      .fc .fc-event { padding:4px 8px!important; border:0!important; border-radius:14px!important; font-family:Impact,"Arial Narrow",sans-serif!important; font-size:14px!important; font-weight:400!important; letter-spacing:.025em; }
      .fc .fc-list { border:2px solid ${color}!important; border-radius:0 22px 22px 0; overflow:hidden; }
      .fc .fc-list-day-cushion { color:${contrast}; background:${color}!important; }
      .fc .fc-list-event:hover td { background:color-mix(in srgb,${color} 18%,#111118)!important; }
    `;
    const apply = (root) => {
      if (!root || root.querySelector?.("style[data-lcars-calendar-theme]")) return;
      const style = document.createElement("style");
      style.dataset.lcarsCalendarTheme = "";
      style.textContent = css;
      root.append(style);
      for (const element of root.querySelectorAll?.("*") || []) if (element.shadowRoot) apply(element.shadowRoot);
      if (!root.__lcarsCalendarObserver) {
        root.__lcarsCalendarObserver = new MutationObserver(() => {
          for (const element of root.querySelectorAll?.("*") || []) if (element.shadowRoot) apply(element.shadowRoot);
        });
        root.__lcarsCalendarObserver.observe(root, { childList: true, subtree: true });
      }
    };
    apply(card.shadowRoot);
    requestAnimationFrame(() => apply(card.shadowRoot));
    window.setTimeout(() => apply(card.shadowRoot), 500);
  }

  renderLcarsCustomMenu(menu) {
    const areas = (this._data || []).filter((area) => area.id !== "__unassigned__")
      .filter((area) => this.matchesConfiguredItem("areas", area.id, area.name))
      .map((area) => ({ ...area, displayDevices: area.devices.filter((device) => this.deviceMatchesCustomMenu(device, menu)) }))
      .filter((area) => area.displayDevices.length);
    const contrast = contrastColor(menu.color);
    return `<section class="lcars-floor lcars-custom-menu" style="--lcars-tone:${menu.color};--lcars-tone-contrast:${contrast}">
      <header><button><ha-icon icon="${escapeHtml(menu.icon || "mdi:view-dashboard-outline")}"></ha-icon>${escapeHtml(menu.title)}</button><i></i><b>${areas.length} SECTOR${areas.length === 1 ? "" : "S"}</b></header>
      <div class="lcars-area-grid">${areas.length ? areas.map((area) => this.renderLcarsArea(area)).join("") : '<div class="lcars-custom-empty">NO MATCHING SYSTEMS</div>'}</div>
    </section>`;
  }

  deviceMatchesCustomMenu(device, menu) {
    const wantedLabels = new Set((menu.labels || []).map((label) => String(label).trim().toLowerCase()));
    const labelMatch = device.labels.some((label) => wantedLabels.has(String(label.name).trim().toLowerCase()) || wantedLabels.has(String(label.label_id).trim().toLowerCase()));
    const wantedProperties = new Set((menu.properties || []).map((property) => String(property).trim().toLowerCase()));
    const propertyMatch = device.entities.some((entity) => {
      const stateObj = this._hass?.states?.[entity.entity_id];
      const domain = entity.entity_id.split(".")[0].toLowerCase();
      const deviceClass = String(stateObj?.attributes?.device_class || entity.device_class || entity.original_device_class || "").toLowerCase();
      return wantedProperties.has(domain) || wantedProperties.has(deviceClass)
        || (wantedProperties.has("illuminance") && ["illuminance", "light"].includes(deviceClass))
        || (wantedProperties.has("battery") && deviceClass === "battery")
        || (wantedProperties.has("location") && ["device_tracker", "person"].includes(domain));
    });
    return labelMatch || propertyMatch;
  }

  renderLcarsArea(area) {
    const deviceGroups = this.lcarsDeviceGroups(area.displayDevices);
    const temperature = this.lcarsConfiguredAreaTemperature(area);
    const areaColor = this.configuredItemColor("area_colors", area.id, area.name);
    const areaStyle = areaColor ? ` style="--lcars-area-tone:${areaColor};--lcars-area-contrast:${contrastColor(areaColor)}"` : "";
    return `<article class="lcars-area" data-area-drop="${escapeHtml(area.id)}"${areaStyle}>
      <header><button data-area-config="${escapeHtml(area.id)}"><ha-icon icon="${escapeHtml(area.icon)}"></ha-icon><strong>${escapeHtml(area.name)}</strong></button>${temperature ? `<button class="lcars-area-reading temp-${temperature.band}" data-entity="${escapeHtml(temperature.entityId)}" title="Open ${escapeHtml(temperature.name)} history"><ha-icon icon="mdi:thermometer"></ha-icon><b>${escapeHtml(temperature.value)}</b></button>` : ""}</header>
      <div class="lcars-devices">${deviceGroups.length ? deviceGroups.map((group) => `<section class="lcars-device-group">${group.devices.map((device) => this.renderLcarsDevice(device, group.color)).join("")}</section>`).join("") : `<span class="lcars-no-devices">NO DEVICES MATCH THE CURRENT FILTER</span>`}</div>
    </article>`;
  }

  lcarsDeviceGroups(devices) {
    const groups = new Map();
    for (const device of devices) {
      const label = this.orderConfiguredItems("labels", device.labels, (entry) => entry.label_id, (entry) => entry.name)[0];
      const id = label?.label_id || "__other__";
      if (!groups.has(id)) groups.set(id, {
        id,
        name: label?.name || "Other systems",
        icon: label?.icon || "mdi:dots-grid",
        color: this.configuredLabelColor(label, device.color ? safeColor(device.color) : "#9999ff"),
        devices: [],
      });
      groups.get(id).devices.push(device);
    }
    const grouped = [...groups.values()];
    return Array.isArray(this._config?.labels)
      ? this.orderConfiguredItems("labels", grouped, (group) => group.id, (group) => group.name)
      : grouped.sort((a, b) => a.name.localeCompare(b.name));
  }

  lcarsConfiguredAreaTemperature(area) {
    if (!area.temperatureEntityId) return null;
    const stateObj = this._hass?.states?.[area.temperatureEntityId];
    if (!stateObj || ["unknown", "unavailable"].includes(stateObj.state)) return null;
    return {
      entityId: area.temperatureEntityId,
      name: stateObj.attributes.friendly_name || area.name,
      value: this._hass?.formatEntityState?.(stateObj) || `${stateObj.state}${stateObj.attributes.unit_of_measurement || "°"}`,
      band: this.temperatureBand(stateObj, area.temperatureEntityId.split(".")[0], "temperature"),
    };
  }

  matchesConfiguredItem(configKey, id, name) {
    const configured = this._config?.[configKey];
    if (!Array.isArray(configured)) return true;
    const values = new Set(configured.map((value) => String(value).trim().toLowerCase()));
    return values.has(String(id || "").toLowerCase()) || values.has(String(name || "").toLowerCase());
  }

  configuredItemColor(configKey, id, name, fallback = "") {
    const overrides = this._config?.[configKey];
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return fallback;
    const match = Object.entries(overrides).find(([key]) => {
      const normalized = String(key).trim().toLowerCase();
      return normalized === String(id || "").toLowerCase() || normalized === String(name || "").toLowerCase();
    });
    return match ? safeColor(match[1], fallback) : fallback;
  }

  configuredLabelColor(label, fallback = "var(--primary-color,#03a9f4)") {
    const defaultColor = safeColor(label?.color, fallback);
    return label ? this.configuredItemColor("label_colors", label.label_id, label.name, defaultColor) : defaultColor;
  }

  orderConfiguredItems(configKey, items, getId, getName) {
    const configured = this._config?.[configKey];
    if (!Array.isArray(configured)) return items;
    const order = new Map(configured.map((value, index) => [String(value).trim().toLowerCase(), index]));
    const rank = (item) => Math.min(
      order.get(String(getId(item) || "").toLowerCase()) ?? Number.POSITIVE_INFINITY,
      order.get(String(getName(item) || "").toLowerCase()) ?? Number.POSITIVE_INFINITY,
    );
    return [...items].sort((a, b) => rank(a) - rank(b));
  }

  renderLcarsDevice(device, groupColor) {
    const color = safeColor(groupColor, safeColor(device.color, "#ff9c5b"));
    const statuses = [];
    const isMobile = device.labels.some((label) => /^mobiles?$/i.test(label.name));
    const offline = device.entities.length > 0 && device.entities.every((entity) => {
      const state = this._hass?.states?.[entity.entity_id]?.state;
      return !state || ["unavailable", "unknown"].includes(state);
    });
    const isPlug = /\bplugs?\b/i.test(device.name) || device.labels.some((label) => /\bplugs?\b/i.test(label.name));
    for (const entity of device.entities) {
      const stateObj = this._hass?.states?.[entity.entity_id];
      if (this.isHiddenProperty(entity, stateObj)) continue;
      if (!stateObj || ["unavailable", "unknown"].includes(stateObj.state)) continue;
      const domain = entity.entity_id.split(".")[0];
      const deviceClass = stateObj.attributes.device_class || entity.device_class || entity.original_device_class || "";
      const zoneName = isMobile && ["device_tracker", "person"].includes(domain) ? this.mobileZoneName(stateObj.state) : null;
      const locationStatus = zoneName
        ? {
            entityId: entity.entity_id,
            name: "Zone",
            value: zoneName,
            icon: "mdi:map-marker",
            category: "location",
            active: false,
            priority: 1,
          }
        : null;
      const status = this.statusForEntity(entity, stateObj, domain, deviceClass, isPlug)
        || locationStatus
        || (["switch", "fan", "media_player", "input_boolean"].includes(domain)
          ? { entityId: entity.entity_id, name: stateObj.attributes.friendly_name || entity.name || device.name, value: stateObj.state === "on" || stateObj.state === "playing" ? "On" : stateObj.state, icon: stateObj.attributes.icon || entity.icon || "mdi:toggle-switch", active: stateObj.state === "on" || stateObj.state === "playing", priority: 6 }
          : null);
      if (status) {
        const percentage = /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(String(status.value))?.[1];
        statuses.push({
          ...status,
          domain,
          percentage: percentage == null ? null : Math.max(0, Math.min(100, Number(percentage))),
          batteryBand: deviceClass === "battery" && percentage != null
            ? (Number(percentage) <= 20 ? "low" : Number(percentage) >= 70 ? "high" : "medium")
            : "",
          temperatureBand: this.temperatureBand(stateObj, domain, deviceClass),
          temperatureColor: this.temperatureColor(stateObj, domain, deviceClass, status.name, device.name),
          temperaturePercentage: this.kettleTemperaturePercentage(stateObj, domain, deviceClass, status.name, device.name),
          adjustable: percentage != null && ["light", "media_player"].includes(domain),
          toggleable: percentage == null && ["light", "switch", "fan", "input_boolean"].includes(domain),
        });
      }
    }
    if (isMobile && !statuses.some((status) => status.category === "location")) {
      const location = this.findMobileLocationStatus(device);
      if (location) statuses.push(location);
    }
    statuses.sort((a, b) => a.priority - b.priority);
    const visibleStatuses = this.dedupeLcarsStatuses(statuses);
    return `<div class="lcars-device" style="--lcars-device:${color};--lcars-device-contrast:${contrastColor(color)}">
      <button class="lcars-device-name ${visibleStatuses.length > 1 ? "multi-status" : "single-status"}" draggable="true" data-device-drag="${escapeHtml(device.id)}" data-device="${escapeHtml(device.id)}" title="Drag to another area, or click to open ${escapeHtml(device.name)} settings"><ha-icon icon="${escapeHtml(device.icon)}"></ha-icon><span>${escapeHtml(device.name)}</span></button>
      <div class="lcars-values">${visibleStatuses.slice(0, 6).map((status) => this.renderLcarsStatus(status)).join("") || `<span class="lcars-standby ${offline ? "offline" : ""}">${offline ? "OFFLINE" : "SYSTEM READY"}</span>`}</div>
    </div>`;
  }

  dedupeLcarsStatuses(statuses) {
    const controls = new Map();
    for (const status of statuses) {
      const isPowerControl = ["light", "switch", "fan", "input_boolean"].includes(status.domain);
      const key = isPowerControl ? `control:${status.name.trim().toLowerCase()}` : status.entityId;
      const existing = controls.get(key);
      if (!existing || status.domain === "light" || (status.adjustable && !existing.adjustable)) controls.set(key, status);
    }
    return [...controls.values()];
  }

  findMobileLocationStatus(device) {
    const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const deviceKey = normalize(device.name);
    if (!deviceKey) return null;
    const candidates = Object.values(this._hass?.states || {}).filter((stateObj) => {
      if (!stateObj?.entity_id || ["unknown", "unavailable"].includes(stateObj.state)) return false;
      const domain = stateObj.entity_id.split(".")[0];
      if (!["device_tracker", "person"].includes(domain) || !this.mobileZoneName(stateObj.state)) return false;
      const text = normalize(`${stateObj.entity_id} ${stateObj.attributes?.friendly_name || ""}`);
      const friendlyKey = normalize(stateObj.attributes?.friendly_name);
      const nameMatches = text.includes(deviceKey) || (friendlyKey && deviceKey.includes(friendlyKey));
      return nameMatches;
    }).sort((a, b) => {
      const score = (stateObj) => {
        const text = `${stateObj.entity_id} ${stateObj.attributes?.friendly_name || ""}`;
        if (stateObj.entity_id.startsWith("person.")) return 0;
        return 1;
      };
      return score(a) - score(b);
    });
    const stateObj = candidates[0];
    if (!stateObj) return null;
    return {
      entityId: stateObj.entity_id,
      name: "Zone",
      value: this.mobileZoneName(stateObj.state),
      icon: "mdi:map-marker",
      category: "location",
      domain: stateObj.entity_id.split(".")[0],
      percentage: null,
      adjustable: false,
      toggleable: false,
      active: false,
      priority: 1,
    };
  }

  mobileZoneName(value) {
    const state = String(value || "").trim();
    if (!state || ["not_home", "unknown", "unavailable"].includes(state.toLowerCase())) return null;
    if (state.toLowerCase() === "home") return "Home";
    const zone = Object.values(this._hass?.states || {}).find((entry) => {
      if (!entry?.entity_id?.startsWith("zone.")) return false;
      const id = entry.entity_id.slice(5).replace(/_/g, " ");
      const name = String(entry.attributes?.friendly_name || id);
      return [id, name].some((candidate) => candidate.toLowerCase() === state.toLowerCase());
    });
    return zone ? String(zone.attributes?.friendly_name || state) : null;
  }

  renderLcarsStatus(status) {
    const meterVariables = [
      status.temperaturePercentage != null
        ? `--level:${status.temperaturePercentage}%`
        : status.percentage == null ? "" : `--level:${status.percentage}%`,
      status.temperatureColor ? `--meter-fill:${status.temperatureColor}` : "",
    ].filter(Boolean).join(";");
    const meterStyle = meterVariables ? ` style="${meterVariables}"` : "";
    const interaction = status.adjustable
      ? `<input type="range" min="0" max="100" step="1" value="${status.percentage}" data-entity-level="${escapeHtml(status.entityId)}" data-level-domain="${escapeHtml(status.domain)}" aria-label="Adjust ${escapeHtml(status.name)}" title="Drag to adjust ${escapeHtml(status.name)}">`
      : "";
    const element = status.adjustable ? "div" : "button";
    const action = status.adjustable
      ? ""
      : status.toggleable
        ? ` data-entity-toggle="${escapeHtml(status.entityId)}"`
        : ` data-entity="${escapeHtml(status.entityId)}"`;
    const title = status.adjustable ? "" : ` title="${status.toggleable ? "Toggle" : "Open"} ${escapeHtml(status.name)}"`;
    return `<${element}${action} class="lcars-meter ${status.active ? "active" : ""} ${status.percentage == null ? "" : "percentage"} ${status.batteryBand ? `battery battery-${status.batteryBand}` : ""} ${status.temperatureBand ? `temperature temp-${status.temperatureBand}` : ""} ${status.adjustable ? "adjustable" : ""}"${meterStyle}${title}><ha-icon icon="${escapeHtml(status.icon)}"></ha-icon><span>${escapeHtml(status.name)}</span><b>${escapeHtml(status.value)}</b>${interaction}</${element}>`;
  }

  temperatureBand(stateObj, domain, deviceClass) {
    if (deviceClass !== "temperature" && domain !== "climate") return "";
    const rawValue = domain === "climate" ? stateObj.attributes.current_temperature : stateObj.state;
    let temperature = Number.parseFloat(rawValue);
    if (!Number.isFinite(temperature)) return "";
    const unit = domain === "climate"
      ? this._hass?.config?.unit_system?.temperature
      : stateObj.attributes.unit_of_measurement;
    if (String(unit || "").toUpperCase().includes("F")) temperature = (temperature - 32) * 5 / 9;
    if (temperature > 25) return "hot";
    if (temperature < 18) return "cold";
    return "normal";
  }

  temperatureColor(stateObj, domain, deviceClass, entityName, deviceName) {
    if (deviceClass !== "temperature" && domain !== "climate") return "";
    if (!/\bkettle\b/i.test(`${entityName || ""} ${deviceName || ""}`)) return "";
    const rawValue = domain === "climate" ? stateObj.attributes.current_temperature : stateObj.state;
    let temperature = Number.parseFloat(rawValue);
    if (!Number.isFinite(temperature)) return "";
    const unit = domain === "climate" ? this._hass?.config?.unit_system?.temperature : stateObj.attributes.unit_of_measurement;
    if (String(unit || "").toUpperCase().includes("F")) temperature = (temperature - 32) * 5 / 9;
    const ratio = Math.max(0, Math.min(1, (temperature - 25) / 75));
    const hue = Math.round((1 - ratio) * 220);
    return `hsl(${hue} 78% 38%)`;
  }

  kettleTemperaturePercentage(stateObj, domain, deviceClass, entityName, deviceName) {
    if (deviceClass !== "temperature" && domain !== "climate") return null;
    if (!/\bkettle\b/i.test(`${entityName || ""} ${deviceName || ""}`)) return null;
    const rawValue = domain === "climate" ? stateObj.attributes.current_temperature : stateObj.state;
    let temperature = Number.parseFloat(rawValue);
    if (!Number.isFinite(temperature)) return null;
    const unit = domain === "climate" ? this._hass?.config?.unit_system?.temperature : stateObj.attributes.unit_of_measurement;
    if (String(unit || "").toUpperCase().includes("F")) temperature = (temperature - 32) * 5 / 9;
    return Math.round(Math.max(0, Math.min(1, (temperature - 25) / 75)) * 1000) / 10;
  }

  nodeStyle(point, canvas) {
    return `--x:${point.x / canvas.width * 100}%;--y:${point.y / canvas.height * 100}%`;
  }

  renderDevice(device, point, canvas) {
    const visibleEntities = device.entities.filter((entity) => !this.isHiddenProperty(entity, this._hass?.states?.[entity.entity_id]));
    const entityRows = this._config.web_show_properties && visibleEntities.length
      ? `<div class="entities">${visibleEntities.map((entity) => {
          const state = this._hass?.states?.[entity.entity_id];
          return `<button data-entity="${escapeHtml(entity.entity_id)}"><span>${escapeHtml(state?.attributes?.friendly_name || entity.name || entity.original_name || entity.entity_id)}</span><b>${escapeHtml(state?.state || "unavailable")}</b></button>`;
        }).join("")}</div>` : "";
    const metadata = [device.manufacturer, device.model].filter(Boolean).join(" · ");
    const deviceColor = safeColor(device.color);
    const statuses = this._config.show_status ? this.deviceStatuses(device) : [];
    return `<article class="device node" draggable="true" data-device-drag="${escapeHtml(device.id)}" data-device="${escapeHtml(device.id)}" title="Drag to another area, or click to open ${escapeHtml(device.name)} settings" style="${this.nodeStyle(point, canvas)};--device-color:${deviceColor}">
      <div class="device-main">
        <span class="device-icon"><ha-icon icon="${escapeHtml(device.icon)}"></ha-icon></span>
        <div class="device-copy"><h3>${escapeHtml(device.name)}</h3></div>
      </div>
      ${metadata ? `<small class="device-metadata">${escapeHtml(metadata)}</small>` : ""}
      ${statuses.length ? `<div class="statuses">${statuses.map((status) => `<button ${status.toggleable ? `data-entity-toggle="${escapeHtml(status.entityId)}"` : `data-entity="${escapeHtml(status.entityId)}"`} class="status ${status.active ? "active" : ""}" title="${status.toggleable ? `Toggle ${escapeHtml(status.name)}` : escapeHtml(status.name)}">
        <ha-icon icon="${escapeHtml(status.icon)}"></ha-icon><span>${escapeHtml(status.value)}</span>
      </button>`).join("")}</div>` : ""}
      ${device.labels.length ? `<div class="labels">${device.labels.map((label) => {
        const color = this.configuredLabelColor(label, deviceColor);
        return `<span style="--label-color:${color};--label-contrast:${contrastColor(color)}">${escapeHtml(label.name)}</span>`;
      }).join("")}</div>` : ""}
      ${entityRows}
    </article>`;
  }

  deviceStatuses(device) {
    const statuses = [];
    const isPlug = /\bplugs?\b/i.test(device.name) || device.labels.some((label) => /\bplugs?\b/i.test(label.name));
    for (const entity of device.entities) {
      const stateObj = this._hass?.states?.[entity.entity_id];
      if (this.isHiddenProperty(entity, stateObj)) continue;
      if (!stateObj || ["unavailable", "unknown"].includes(stateObj.state)) continue;
      const domain = entity.entity_id.split(".")[0];
      const deviceClass = stateObj.attributes.device_class || entity.device_class || entity.original_device_class || "";
      const status = this.statusForEntity(entity, stateObj, domain, deviceClass, isPlug);
      if (status) {
        const group = domain === "light" || domain === "switch"
          ? "power"
          : domain === "binary_sensor" && ["door", "garage_door", "opening", "window"].includes(deviceClass)
            ? "opening"
            : domain === "sensor" && deviceClass
              ? `sensor:${deviceClass}`
              : domain;
        statuses.push({ ...status, group, toggleable: ["light", "switch", "fan", "input_boolean"].includes(domain) });
      }
    }
    const representativeStatuses = [...statuses.reduce((groups, status) => {
      const existing = groups.get(status.group);
      if (!existing || (status.active && !existing.active)) groups.set(status.group, status);
      return groups;
    }, new Map()).values()];
    representativeStatuses.sort((a, b) => a.priority - b.priority);
    const limit = Math.max(1, Math.min(8, Number(this._config.max_statuses) || 3));
    return representativeStatuses.slice(0, limit);
  }

  isHiddenProperty(entity, stateObj) {
    if (!this._config.hide_child_lock) return false;
    const text = [
      entity?.entity_id,
      entity?.name,
      entity?.original_name,
      stateObj?.attributes?.friendly_name,
    ].filter(Boolean).join(" ");
    return /\bchild[ _-]?locks?(?:\b|_)/i.test(text);
  }

  statusForEntity(entity, stateObj, domain, deviceClass, isPlug = false) {
    const on = stateObj.state === "on";
    const formatted = () => this._hass?.formatEntityState?.(stateObj)
      || `${stateObj.state}${stateObj.attributes.unit_of_measurement ? ` ${stateObj.attributes.unit_of_measurement}` : ""}`;
    const common = {
      entityId: entity.entity_id,
      name: stateObj.attributes.friendly_name || entity.name || entity.original_name || entity.entity_id,
    };

    if (domain === "sensor" && deviceClass === "battery") {
      const percentage = Number.parseFloat(stateObj.state);
      const numeric = Number.isFinite(percentage);
      const value = numeric ? `${Math.round(percentage)}%` : formatted();
      const low = numeric && percentage <= 20;
      const icon = low ? "mdi:battery-alert" : numeric && percentage <= 50 ? "mdi:battery-medium" : "mdi:battery-high";
      return { ...common, priority: 0, active: low, value, icon };
    }
    if (domain === "binary_sensor" && ["door", "garage_door", "opening", "window"].includes(deviceClass)) {
      const label = deviceClass === "window" ? (on ? "Open" : "Closed") : (on ? "Open" : "Closed");
      return { ...common, priority: 1, active: on, value: label, icon: on ? "mdi:door-open" : "mdi:door-closed" };
    }
    if (domain === "lock") {
      const unlocked = stateObj.state === "unlocked";
      return { ...common, priority: 1, active: unlocked, value: unlocked ? "Unlocked" : "Locked", icon: unlocked ? "mdi:lock-open-variant" : "mdi:lock" };
    }
    if (domain === "cover") {
      const open = stateObj.state === "open";
      return { ...common, priority: 1, active: open, value: open ? "Open" : "Closed", icon: open ? "mdi:window-open" : "mdi:window-closed" };
    }
    if (domain === "light") {
      const brightness = Number(stateObj.attributes.brightness);
      const percentage = Number.isFinite(brightness) ? (on ? Math.round(brightness / 255 * 100) : 0) : null;
      return { ...common, priority: 2, active: on, value: percentage == null ? (on ? "On" : "Off") : `${percentage}%`, icon: on ? "mdi:lightbulb-on" : "mdi:lightbulb-outline" };
    }
    if (domain === "switch" && (deviceClass === "outlet" || isPlug)) {
      return { ...common, priority: 2, active: on, value: on ? "On" : "Off", icon: on ? "mdi:power-plug" : "mdi:power-plug-off" };
    }
    if (domain === "media_player") {
      const volume = Number(stateObj.attributes.volume_level);
      const playing = ["on", "playing", "paused", "idle"].includes(stateObj.state);
      return { ...common, priority: 2, active: stateObj.state === "playing", value: Number.isFinite(volume) ? `${Math.round(volume * 100)}%` : (playing ? stateObj.state : "Off"), icon: Number.isFinite(volume) && volume === 0 ? "mdi:volume-mute" : "mdi:volume-high" };
    }
    if (domain === "climate") {
      const temperature = stateObj.attributes.current_temperature;
      const unit = this._hass?.config?.unit_system?.temperature || "°";
      return { ...common, priority: 3, active: stateObj.state !== "off", value: temperature == null ? stateObj.state : `${temperature}${unit}`, icon: "mdi:thermostat" };
    }
    if (domain === "sensor" && deviceClass === "temperature") {
      return { ...common, priority: 3, active: false, value: formatted(), icon: "mdi:thermometer" };
    }
    if (domain === "sensor" && ["illuminance", "irradiance"].includes(deviceClass)) {
      return { ...common, priority: 4, active: false, value: formatted(), icon: "mdi:brightness-5" };
    }
    if (domain === "sensor" && deviceClass === "humidity") {
      return { ...common, priority: 5, active: false, value: formatted(), icon: "mdi:water-percent" };
    }
    return null;
  }

  styles() { return `
    :host { display:block; --at-accent:var(--primary-color,#03a9f4); --at-floor:#00897b; --at-area:#7e57c2; --at-line:color-mix(in srgb,var(--at-accent) 35%,transparent); }
    * { box-sizing:border-box; }
    ha-card { overflow:hidden; background:var(--ha-card-background,var(--card-background-color,#fff)); }
    .header { display:block; padding:18px 24px 14px; border-bottom:1px solid var(--divider-color,#ddd); }
    .header-main { display:flex; justify-content:space-between; align-items:center; gap:16px; }
    .header h1 { font-size:20px; line-height:1.2; margin:0; font-weight:600; }
    .header .version { display:inline-flex; margin-left:6px; padding:2px 6px; border-radius:5px; color:var(--secondary-text-color,#727272); background:var(--secondary-background-color,#f1f1f1); font-size:14px; font-weight:600; vertical-align:middle; }
    .header p { color:var(--secondary-text-color,#727272); margin:5px 0 0; font-size:13px; }
    .header-main>ha-icon { color:var(--at-accent); --mdc-icon-size:30px; }
    .header-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:7px; }
    .header-actions button { display:flex; align-items:center; gap:5px; padding:7px 10px; border:1px solid var(--divider-color,#ddd); border-radius:9px; color:var(--primary-text-color,#222); background:var(--secondary-background-color,#f1f1f1); font:inherit; font-size:12px; cursor:pointer; }
    .header-actions button:hover { border-color:var(--at-accent); color:var(--at-accent); }
    .header-actions span { font-size:17px; line-height:10px; }
    .layout-controls { display:flex; align-items:stretch; }
    .header-actions .layout-controls button { padding:5px 8px; border-radius:0; }
    .header-actions .layout-controls button:first-child { border-radius:9px 0 0 9px; }
    .header-actions .layout-controls button+button { margin-left:-1px; border-radius:0; }
    .header-actions .layout-controls button:last-child { border-radius:0 9px 9px 0; }
    .header-actions .layout-controls button.active { position:relative; color:white; border-color:var(--at-accent); background:var(--at-accent); }
    .layout-controls ha-icon { width:15px; height:15px; --mdc-icon-size:15px; }
    .zoom-controls { display:flex; align-items:stretch; }
    .header-actions .zoom-controls button { min-width:30px; padding:5px 8px; border-radius:0; font-size:15px; font-weight:600; justify-content:center; }
    .header-actions .zoom-controls button:first-child { border-radius:9px 0 0 9px; }
    .header-actions .zoom-controls button+button { margin-left:-1px; }
    .header-actions .zoom-controls button:last-child { border-radius:0 9px 9px 0; }
    .header-actions .zoom-controls .zoom-level { min-width:48px; font-size:10px; font-weight:500; }
    .header-actions .toggle-control { padding-left:8px; }
    .toggle-control .switch { position:relative; width:30px; height:17px; border-radius:999px; background:var(--disabled-color,#9e9e9e); transition:background .18s ease; }
    .toggle-control .switch i { position:absolute; top:3px; left:3px; width:11px; height:11px; border-radius:50%; background:white; transition:transform .18s ease; }
    .toggle-control.active .switch { background:var(--at-accent); }
    .toggle-control.active .switch i { transform:translateX(13px); }
    .label-filters { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:13px; padding-top:11px; border-top:1px solid var(--divider-color,#ddd); }
    .filter-caption { margin-right:3px; color:var(--secondary-text-color,#727272); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
    .label-filter { display:inline-flex; align-items:center; gap:5px; min-height:28px; padding:4px 10px; border:2px solid var(--label-color,var(--at-accent)); border-radius:999px; color:var(--label-color,var(--primary-text-color,#222)); background:transparent; font:inherit; font-size:11px; font-weight:600; cursor:pointer; opacity:.72; }
    .label-filter:hover { opacity:1; }
    .label-filter.selected { color:var(--label-contrast,#fff); background:var(--label-color,var(--at-accent)); opacity:1; box-shadow:0 1px 5px color-mix(in srgb,var(--label-color,var(--at-accent)) 38%,transparent); }
    .label-filter.all { --label-color:#000; --label-contrast:#fff; color:#fff; background:#000; border-color:#000; box-shadow:0 0 0 1px rgba(255,255,255,.35); }
    .label-filter ha-icon { width:15px; height:15px; --mdc-icon-size:15px; }
    .content { padding:0; }
    .workspace { display:flex; width:100%; min-width:0; }
    .tree-scroll { --tree-background:color-mix(in srgb,var(--card-background-color,#fff) 96%,var(--at-accent)); flex:1 1 auto; min-width:0; height:var(--map-height); overflow:auto; padding:22px 28px 40px; background:var(--tree-background); }
    .topology-tree { min-width:760px; color:var(--primary-text-color,#222); font-size:var(--tree-font,14px); }
    .tree-children { position:relative; margin-left:19px; padding-left:25px; border-left:1px solid color-mix(in srgb,var(--at-accent) 42%,var(--divider-color,#ddd)); }
    .tree-branch { position:relative; padding-top:8px; }
    .tree-branch::before { content:""; position:absolute; z-index:1; top:30px; left:-25px; width:24px; border-top:1px solid color-mix(in srgb,var(--at-accent) 42%,var(--divider-color,#ddd)); }
    .tree-branch:last-child::after { content:""; position:absolute; z-index:0; top:31px; bottom:0; left:-26px; width:3px; background:var(--tree-background); }
    .tree-row { position:relative; min-height:44px; display:flex; align-items:center; gap:8px; width:max-content; min-width:430px; max-width:900px; padding:5px 9px; border:1px solid transparent; border-radius:9px; }
    .tree-home { padding:8px 11px; border-color:color-mix(in srgb,var(--at-accent) 55%,var(--divider-color,#ddd)); background:color-mix(in srgb,var(--at-accent) 9%,var(--card-background-color,#fff)); }
    .tree-floor { border-color:color-mix(in srgb,var(--at-floor) 55%,var(--divider-color,#ddd)); background:color-mix(in srgb,var(--at-floor) 9%,var(--card-background-color,#fff)); }
    .tree-area { border-color:color-mix(in srgb,var(--at-area) 55%,var(--divider-color,#ddd)); background:color-mix(in srgb,var(--at-area) 9%,var(--card-background-color,#fff)); }
    .tree-area.drop-target { border-color:var(--success-color,#43a047); background:color-mix(in srgb,var(--success-color,#43a047) 22%,var(--card-background-color,#fff)); box-shadow:0 0 0 4px color-mix(in srgb,var(--success-color,#43a047) 15%,transparent); }
    .tree-device { border-color:color-mix(in srgb,var(--device-color) 65%,var(--divider-color,#ddd)); background:color-mix(in srgb,var(--device-color) 9%,var(--card-background-color,#fff)); cursor:grab; }
    .tree-device:hover { z-index:4; box-shadow:0 3px 12px color-mix(in srgb,var(--device-color) 22%,transparent); }
    .tree-device:active { cursor:grabbing; } .tree-device.dragging { opacity:.42; }
    .tree-toggle { display:grid; place-items:center; flex:0 0 22px; width:22px; height:22px; padding:0; border:1px solid var(--divider-color,#ddd); border-radius:6px; color:var(--primary-text-color,#222); background:var(--card-background-color,#fff); font:inherit; font-size:14px; cursor:pointer; }
    .tree-toggle.empty { visibility:hidden; cursor:default; }
    .tree-main { min-width:0; flex:1; display:flex; align-items:center; gap:8px; padding:0; border:0; color:inherit; background:none; text-align:left; font:inherit; cursor:pointer; }
    .tree-node-icon { display:grid; place-items:center; flex:0 0 30px; width:30px; height:30px; border-radius:7px; color:var(--at-accent); background:color-mix(in srgb,currentColor 12%,var(--card-background-color,#fff)); }
    .tree-floor .tree-node-icon { color:var(--at-floor); } .tree-area .tree-node-icon { color:var(--at-area); } .tree-device .tree-node-icon { color:var(--device-color); }
    .tree-node-icon ha-icon { --mdc-icon-size:19px; }
    .tree-copy { min-width:0; display:flex; flex-direction:column; line-height:1.2; }
    .tree-copy strong { font-size:var(--tree-font,14px); overflow-wrap:anywhere; } .tree-copy small { margin-top:3px; font-size:var(--tree-small,11px); }
    .tree-labels { display:flex; flex-wrap:wrap; gap:4px; margin-left:auto; padding-left:14px; }
    .tree-labels>span { padding:3px 7px; border-radius:999px; color:var(--label-contrast,#fff); background:var(--label-color); font-size:var(--tree-label,10px); font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.18); }
    .tree-properties { padding-top:2px; }
    .tree-property { position:relative; width:max-content; min-width:520px; max-width:900px; display:grid; grid-template-columns:22px minmax(220px,1fr) auto; align-items:center; gap:8px; margin-top:5px; padding:6px 10px; border:1px solid color-mix(in srgb,var(--device-color) 30%,var(--divider-color,#ddd)); border-radius:7px; color:var(--primary-text-color,#222); background:var(--card-background-color,#fff); text-align:left; font:inherit; cursor:pointer; }
    .tree-property::before { content:""; position:absolute; top:50%; left:-26px; width:25px; border-top:1px solid color-mix(in srgb,var(--device-color) 42%,var(--divider-color,#ddd)); }
    .tree-property ha-icon { color:var(--device-color); --mdc-icon-size:16px; }
    .tree-property>span { min-width:0; } .tree-property b { display:block; font-size:var(--tree-property,12px); overflow-wrap:anywhere; } .tree-property small { margin-top:2px; font-size:var(--tree-id,10px); }
    .tree-property em { color:var(--secondary-text-color,#727272); font-size:var(--tree-property,12px); font-style:normal; white-space:nowrap; }
    .topology-scroll { flex:1 1 auto; min-width:0; height:var(--map-height); overflow:auto; overscroll-behavior:contain; background:radial-gradient(circle at center,color-mix(in srgb,var(--at-accent) 8%,transparent),transparent 47%); scrollbar-color:color-mix(in srgb,var(--at-accent) 45%,transparent) transparent; }
    .topology-canvas { position:relative; flex:none; }
    .topology { position:relative; min-width:1200px; min-height:1000px; overflow:hidden; transform:scale(var(--zoom)); transform-origin:0 0; }
    .web { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
    .web line { vector-effect:non-scaling-stroke; stroke-linecap:round; }
    .floor-line { stroke:var(--at-floor); stroke-width:3.5; opacity:.62; }
    .area-line { stroke:var(--at-accent); stroke-width:3; opacity:.5; }
    .device-line { stroke:color-mix(in srgb,var(--line-color,var(--at-accent)) 72%,transparent); stroke-width:1.5; stroke-dasharray:5 5; }
    .node { position:absolute; left:var(--x); top:var(--y); transform:translate(-50%,-50%); z-index:1; }
    .home { width:156px; height:92px; display:flex; flex-direction:column; align-items:center; justify-content:center; border:2px solid var(--at-accent); border-radius:50%; color:var(--primary-text-color,#222); background:var(--card-background-color,#fff); box-shadow:0 0 0 8px color-mix(in srgb,var(--at-accent) 9%,transparent),0 8px 28px rgba(0,0,0,.16); z-index:3; }
    .home>span { display:grid; place-items:center; width:38px; height:38px; margin-top:-3px; border-radius:50%; color:white; background:var(--at-accent); }
    .home-icon svg { width:24px; height:24px; fill:currentColor; }
    .home strong { margin-top:5px; font-size:16px; }
    .floor { width:190px; min-height:78px; display:flex; align-items:center; padding:5px; border:2px solid var(--at-floor); border-radius:18px; color:var(--primary-text-color,#222); background:color-mix(in srgb,var(--at-floor) 10%,var(--card-background-color,#fff)); box-shadow:0 6px 18px rgba(0,0,0,.14); z-index:2; }
    .floor.collapsed { background:color-mix(in srgb,var(--at-floor) 20%,var(--card-background-color,#fff)); }
    .floor-main { min-width:0; flex:1; display:flex; align-items:flex-start; gap:9px; padding:5px; border:0; color:inherit; background:none; font:inherit; text-align:left; cursor:pointer; }
    .floor-icon { display:grid; place-items:center; flex:0 0 42px; width:42px; height:42px; margin-top:1px; border-radius:12px; color:var(--at-floor); background:color-mix(in srgb,var(--at-floor) 18%,var(--card-background-color,#fff)); }
    .floor-icon ha-icon { --mdc-icon-size:24px; }
    .area { width:180px; min-height:72px; display:flex; align-items:center; padding:5px; border:2px solid var(--at-area); border-radius:999px; color:var(--primary-text-color,#222); background:color-mix(in srgb,var(--at-area) 8%,var(--card-background-color,#fff)); box-shadow:0 5px 16px rgba(0,0,0,.12); z-index:2; font:inherit; text-align:left; }
    .area:hover { box-shadow:0 0 0 5px color-mix(in srgb,var(--at-area) 12%,transparent),0 5px 16px rgba(0,0,0,.14); }
    .area.collapsed { background:color-mix(in srgb,var(--at-area) 16%,var(--card-background-color,#fff)); }
    .area.drop-target { transform:translate(-50%,-50%) scale(1.08); background:color-mix(in srgb,var(--success-color,#43a047) 22%,var(--card-background-color,#fff)); border-color:var(--success-color,#43a047); box-shadow:0 0 0 8px color-mix(in srgb,var(--success-color,#43a047) 18%,transparent),0 7px 20px rgba(0,0,0,.18); }
    .area-main { min-width:0; flex:1; display:flex; align-items:flex-start; gap:9px; padding:5px; border:0; color:inherit; background:none; font:inherit; text-align:left; cursor:pointer; }
    .area .toggle,.floor .toggle { display:grid; place-items:center; flex:0 0 24px; width:24px; height:24px; margin-right:4px; padding:0; border:0; border-radius:50%; color:white; font:inherit; font-size:17px; line-height:1; cursor:pointer; }
    .area .toggle { background:var(--at-area); } .floor .toggle { background:var(--at-floor); }
    .area-icon,.device-icon { display:grid; place-items:center; flex:0 0 auto; border-radius:50%; }
    .area-icon { color:var(--at-area); background:color-mix(in srgb,var(--at-area) 16%,var(--card-background-color,#fff)); }
    .area-icon { width:40px; height:40px; margin-top:1px; }
    h2,h3 { margin:0; font-weight:600; }
    h2 { font-size:16px; } h3 { font-size:14px; overflow-wrap:anywhere; }
    small { display:block; margin-top:3px; color:var(--secondary-text-color,#727272); line-height:1.25; }
    .device { width:170px; padding:10px; border:1px solid color-mix(in srgb,var(--device-color) 50%,var(--divider-color,#ddd)); border-radius:12px; color:var(--primary-text-color,#222); background:color-mix(in srgb,var(--device-color) 6%,var(--card-background-color,#fff)); box-shadow:0 3px 11px rgba(0,0,0,.1); cursor:grab; }
    .device:hover { z-index:20; box-shadow:0 0 0 4px color-mix(in srgb,var(--device-color) 10%,transparent),0 8px 22px rgba(0,0,0,.24); }
    .device:active { cursor:grabbing; } .device.dragging { z-index:30; opacity:.42; }
    .device-main { display:flex; align-items:flex-start; gap:10px; }
    .device-icon { width:34px; height:34px; margin-top:1px; color:var(--device-color); background:color-mix(in srgb,var(--device-color) 16%,var(--card-background-color,#fff)); } .device-icon ha-icon { --mdc-icon-size:20px; }
    .device-copy { min-width:0; }
    .device-metadata { margin-top:5px; }
    .statuses { display:flex; flex-wrap:wrap; gap:4px; margin:8px 0 0; }
    .status { display:inline-flex; align-items:center; gap:3px; min-height:22px; padding:2px 6px; border:0; border-radius:7px; color:var(--secondary-text-color,#727272); background:var(--secondary-background-color,#eee); font:inherit; font-size:10px; cursor:pointer; }
    .status.active { color:var(--state-active-color,var(--warning-color,#f9a825)); background:color-mix(in srgb,var(--state-active-color,var(--warning-color,#f9a825)) 15%,var(--card-background-color,#fff)); }
    [data-entity-toggle].working { opacity:.55; pointer-events:none; }
    .status ha-icon { width:13px; height:13px; --mdc-icon-size:13px; }
    .labels { display:flex; flex-wrap:wrap; gap:4px; margin:7px 0 0; }
    .labels span { display:inline-flex; align-items:center; gap:3px; padding:3px 8px; border-radius:999px; color:var(--label-contrast,#fff); background:var(--label-color); font-size:10px; font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.2); }
    .entities { margin:9px 0 0; border-top:1px solid var(--divider-color,#ddd); padding-top:5px; }
    .entities button { width:100%; border:0; background:none; color:var(--primary-text-color,#222); display:flex; justify-content:space-between; gap:8px; padding:5px 0; cursor:pointer; text-align:left; font:inherit; font-size:11px; }
    .entities b { color:var(--secondary-text-color,#727272); font-weight:400; white-space:nowrap; }
    .unassigned-panel { flex:0 0 285px; width:285px; height:var(--map-height); overflow:hidden; display:flex; flex-direction:column; border-left:1px solid var(--divider-color,#ddd); background:var(--card-background-color,#fff); }
    .panel-head { display:flex; justify-content:space-between; align-items:center; padding:16px 16px 10px; }
    .panel-head h2 { font-size:16px; }
    .panel-toggle { display:flex; align-items:center; gap:5px; padding:6px 7px; border:1px solid var(--divider-color,#ddd); border-radius:8px; color:var(--primary-text-color,#222); background:var(--secondary-background-color,#f1f1f1); font:inherit; font-size:10px; cursor:pointer; }
    .panel-toggle:hover { border-color:var(--at-accent); }
    .panel-search { display:flex; align-items:center; gap:7px; margin:0 12px 10px; padding:7px 9px; border:1px solid var(--divider-color,#ddd); border-radius:9px; color:var(--secondary-text-color,#727272); background:var(--secondary-background-color,#f1f1f1); }
    .panel-search:focus-within { border-color:var(--at-accent); box-shadow:0 0 0 2px color-mix(in srgb,var(--at-accent) 14%,transparent); }
    .panel-search ha-icon { flex:0 0 17px; width:17px; height:17px; --mdc-icon-size:17px; }
    .panel-search input { min-width:0; width:100%; padding:0; border:0; outline:0; color:var(--primary-text-color,#222); background:transparent; font:inherit; font-size:11px; }
    .panel-help { margin:0 16px 12px; color:var(--secondary-text-color,#727272); font-size:11px; line-height:1.35; }
    .assignment-message { margin:0 12px 10px; padding:8px 10px; border-radius:8px; color:var(--primary-text-color,#222); background:var(--secondary-background-color,#eee); font-size:11px; }
    .assignment-message.success { color:var(--success-color,#43a047); } .assignment-message.error { color:var(--error-color,#db4437); }
    .unassigned-list { flex:1; min-height:0; overflow:auto; padding:0 10px 14px; }
    .unassigned-device { display:flex; align-items:flex-start; gap:8px; margin-bottom:8px; padding:9px 8px; border:1px solid color-mix(in srgb,var(--device-color) 42%,var(--divider-color,#ddd)); border-radius:10px; background:color-mix(in srgb,var(--device-color) 6%,var(--card-background-color,#fff)); cursor:grab; box-shadow:0 2px 6px rgba(0,0,0,.08); }
    .unassigned-device.label-coloured { border-color:color-mix(in srgb,var(--device-color) 78%,var(--divider-color,#ddd)); background:color-mix(in srgb,var(--device-color) 16%,var(--card-background-color,#fff)); box-shadow:0 2px 8px color-mix(in srgb,var(--device-color) 24%,transparent); }
    .unassigned-device:active { cursor:grabbing; } .unassigned-device.dragging { opacity:.42; }
    .drag-handle { align-self:center; color:var(--secondary-text-color,#727272); font-weight:700; letter-spacing:-3px; }
    .unassigned-device .device-icon { flex:0 0 32px; width:32px; height:32px; }
    .unassigned-device>button { min-width:0; flex:1; padding:0; border:0; color:var(--primary-text-color,#222); background:none; text-align:left; font:inherit; cursor:pointer; }
    .unassigned-device strong { display:block; overflow-wrap:anywhere; font-size:12px; }
    .unassigned-device small { font-size:10px; }
    .panel-labels { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; }
    .panel-labels>span { display:inline-flex; padding:2px 6px; border-radius:999px; color:var(--label-contrast,#fff); background:var(--label-color); font-size:9px; font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.2); }
    .panel-empty { padding:28px 10px; color:var(--secondary-text-color,#727272); text-align:center; font-size:12px; }
    .lcars-dashboard { min-height:var(--map-height,680px); padding:18px; color:#f5f1ff; background:#050507; font-family:Arial Narrow,Roboto Condensed,Arial,sans-serif; }
    .lcars-masthead { display:grid; grid-template-columns:90px minmax(150px,1fr) max-content max-content 42px; align-items:stretch; min-height:64px; margin-bottom:12px; text-transform:uppercase; }
    .lcars-cap { background:var(--lcars-header,#263f4b); }
    .lcars-title { display:flex; align-items:center; justify-content:flex-end; padding:10px 18px; color:#fff; background:var(--lcars-header,#263f4b); }
    .lcars-title strong { font-family:Impact,"Arial Narrow",sans-serif; font-size:26px; font-weight:400; letter-spacing:.025em; line-height:1; text-transform:uppercase; }
    .lcars-clock,.lcars-date { display:flex; align-items:center; justify-content:flex-end; padding:10px 8px; color:var(--lcars-datetime,#ff9900); background:#050507; font-family:Impact,"Arial Narrow",sans-serif; font-size:27px; font-weight:400; letter-spacing:.025em; line-height:1; white-space:nowrap; }
    .lcars-clock { padding-left:16px; }.lcars-date { padding-right:16px; }
    .lcars-end { margin-left:10px; border-radius:0 34px 34px 0; background:var(--lcars-header,#263f4b); }
    .lcars-body { display:grid; grid-template-columns:210px minmax(0,1fr); gap:18px; align-items:start; }
    .lcars-main { min-width:0; }
    .lcars-floor-nav { position:sticky; top:12px; z-index:12; align-self:start; display:flex; flex-direction:column; gap:7px; padding:0 0 8px; }
    .lcars-nav-cap { height:72px; border-top:28px solid #7893a4; border-radius:0 30px 0 0; background:#263c48; box-sizing:border-box; }
    .lcars-nav-foot { height:72px; margin-top:4px; border-bottom:28px solid #7893a4; border-radius:0 0 30px 0; background:#263c48; box-sizing:border-box; }
    .lcars-floor-nav button { display:grid; grid-template-columns:58px minmax(0,1fr); gap:5px; min-height:54px; padding:0; border:0; color:var(--nav-contrast); background:transparent; font:inherit; text-align:left; cursor:pointer; }
    .lcars-floor-nav button:hover { filter:brightness(1.12); transform:translateX(3px); }
    .lcars-floor-nav button.active { filter:brightness(1.14); }
    .lcars-floor-nav button.active b { box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--nav-contrast) 55%,transparent); }
    .lcars-floor-nav button span,.lcars-floor-nav button b { min-width:0; display:flex; align-items:center; height:54px; background:var(--nav-color); box-sizing:border-box; }
    .lcars-floor-nav button span { justify-content:center; border-radius:28px 0 0 28px; font-family:Impact,"Arial Narrow",sans-serif; font-size:29px; font-weight:400; letter-spacing:.02em; }
    .lcars-floor-nav button b { padding:0 11px; overflow:hidden; font-family:Impact,"Arial Narrow",sans-serif; font-size:15px; font-weight:400; letter-spacing:.025em; line-height:1; text-overflow:ellipsis; text-transform:uppercase; white-space:nowrap; }
    .lcars-floor { --lcars-tone:#cc99cc; --lcars-tone-contrast:#08080a; margin-top:14px; scroll-margin-top:14px; }.lcars-tone-1 { --lcars-tone:#ff9966; }.lcars-tone-2 { --lcars-tone:#ffcc99; }.lcars-tone-3 { --lcars-tone:#9999ff; }
    .lcars-main>.lcars-floor:first-child { margin-top:0; }
    .lcars-floor>header { display:grid; grid-template-columns:280px minmax(80px,1fr) auto; height:48px; align-items:stretch; text-transform:uppercase; }
    .lcars-floor>header button { display:flex; align-items:center; gap:8px; padding:7px 15px; border:0; border-radius:25px 0 0 0; color:var(--lcars-tone-contrast); background:var(--lcars-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; line-height:1.2; font-weight:400; letter-spacing:.025em; text-transform:uppercase; cursor:pointer; }
    .lcars-floor>header button ha-icon { flex:0 0 20px; width:20px; height:20px; --mdc-icon-size:20px; }.lcars-floor>header i { margin:0 10px 7px; border-bottom:8px solid var(--lcars-tone); }
    .lcars-floor>header b { align-self:end; min-width:115px; padding:7px 16px; border-radius:20px 20px 0 0; color:var(--lcars-tone-contrast); background:var(--lcars-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:22px; font-weight:400; letter-spacing:.035em; line-height:1; text-align:right; }
    .lcars-area-grid { --lcars-area-tone:var(--lcars-tone); --lcars-area-contrast:var(--lcars-tone-contrast,#08080a); --lcars-area-rail:64px; --lcars-area-rail-gap:12px; position:relative; display:grid; grid-template-columns:repeat(auto-fit,minmax(460px,1fr)); grid-auto-rows:4px; grid-auto-flow:row dense; align-items:start; column-gap:16px; row-gap:16px; margin-left:0; padding:14px 0 18px calc(var(--lcars-area-rail) + var(--lcars-area-rail-gap)); }
    .standalone-lcars .lcars-area-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .lcars-area-grid::before { content:""; position:absolute; top:0; bottom:-12px; left:0; width:var(--lcars-area-rail); background:var(--lcars-area-tone); }
    .lcars-custom-empty { grid-column:1 / -1; display:grid; place-items:center; min-height:220px; color:var(--lcars-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:22px; letter-spacing:.04em; }
    .lcars-area { position:relative; z-index:1; min-width:0; border:2px solid var(--lcars-area-tone); border-radius:0 20px 20px 0; overflow:hidden; background:#0b0b0f; }
    .lcars-area.drop-target { box-shadow:0 0 0 4px #99ffcc; }.lcars-area>header { display:flex; height:52px; padding-bottom:4px; background:var(--lcars-area-tone); }
    .lcars-area>header>button[data-area-config] { min-width:0; flex:1; display:flex; align-items:center; gap:8px; padding:7px 15px 7px 13px; border:0; color:var(--lcars-area-contrast); background:none; font:inherit; text-align:left; cursor:pointer; }
    .lcars-area>header strong { overflow:hidden; font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; font-weight:400; letter-spacing:.025em; line-height:1.2; text-overflow:ellipsis; text-transform:uppercase; white-space:nowrap; }.lcars-area>header>button[data-area-config]>ha-icon { flex:0 0 20px; width:20px; height:20px; --mdc-icon-size:20px; }
    .lcars-area-reading { flex:0 0 auto; align-self:center; width:max-content; min-height:36px; display:flex; align-items:center; justify-content:center; gap:5px; margin:0 8px 0 6px; padding:5px 11px; border:0; border-radius:999px; color:#fff; background:#607d8b; font:inherit; text-shadow:0 1px 2px #000; cursor:pointer; }.lcars-area-reading.temp-cold { background:#1565c0; }.lcars-area-reading.temp-normal { background:#2e7d32; }.lcars-area-reading.temp-hot { background:#c62828; }.lcars-area-reading ha-icon { color:#fff; --mdc-icon-size:16px; }.lcars-area-reading b { color:#fff; font-size:14px; white-space:nowrap; }
    .lcars-floor-camera>header>button { min-width:0; flex:1; display:flex; align-items:center; gap:8px; padding:7px 15px 7px 13px; border:0; color:var(--lcars-area-contrast); background:none; font:inherit; text-align:left; }
    .lcars-floor-camera>header>button ha-icon { flex:0 0 20px; --mdc-icon-size:20px; }
    .lcars-floor-camera-state { align-self:center; margin-right:10px; padding:6px 11px; border-radius:999px; color:var(--lcars-area-contrast); background:color-mix(in srgb,var(--lcars-area-contrast) 13%,transparent); font-family:Impact,"Arial Narrow",sans-serif; font-size:14px; font-weight:400; text-transform:uppercase; }
    .lcars-floor-camera-card { min-height:330px; background:#050507; }
    .lcars-floor-camera-card>* { display:block; --ha-card-border-width:0; --ha-card-border-radius:0; --ha-card-box-shadow:none; }
    .lcars-devices { padding:9px 0 12px 8px; }.lcars-device-group { margin-top:12px; }.lcars-device-group:first-child { margin-top:0; }.lcars-device { display:grid; grid-template-columns:minmax(180px,.9fr) minmax(250px,1.3fr); gap:8px; padding:9px 8px 9px 0; }
    .lcars-device-name { min-width:0; min-height:42px; display:flex; align-items:center; gap:9px; padding:10px 13px; border:0; border-radius:20px 0 0 20px; color:var(--lcars-device-contrast); background:var(--lcars-device); font-family:Impact,"Arial Narrow",sans-serif; font-size:16px; font-weight:400; letter-spacing:.02em; text-align:left; cursor:pointer; }
    .lcars-device-name.multi-status { align-items:flex-start; padding-top:14px; }
    .lcars-device-name ha-icon { flex:0 0 21px; --mdc-icon-size:21px; }.lcars-device-name span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .lcars-values { min-width:0; display:flex; flex-direction:column; gap:6px; }.lcars-meter { --meter-fill:#ff9900; position:relative; min-width:0; display:grid; grid-template-columns:19px minmax(115px,1fr) auto; align-items:center; gap:8px; min-height:42px; padding:6px 12px; border:0; border-radius:0 21px 21px 0; color:#d9d2e9; background:linear-gradient(90deg,var(--meter-fill) 0 var(--level,0%),#1b1722 var(--level,0%) 100%); font:inherit; font-size:13px; text-align:left; cursor:pointer; overflow:hidden; }
    .lcars-meter.active:not(.percentage) { --level:100%; color:#08080a; }.lcars-meter.percentage { --meter-fill:#9a5700; color:#fff; font-weight:600; text-shadow:0 1px 3px #000,0 0 2px #000; box-shadow:inset 0 0 0 1px rgba(255,204,153,.16); }.lcars-meter.adjustable.percentage { --meter-fill:#5858b8; }.lcars-meter.battery-low { --meter-fill:#c62828; }.lcars-meter.battery-medium { --meter-fill:#ef6c00; }.lcars-meter.battery-high { --meter-fill:#2e7d32; }.lcars-meter.temperature { --level:100%; color:#fff; font-weight:700; text-shadow:0 1px 3px #000; }.lcars-meter.temp-cold { --meter-fill:#1565c0; }.lcars-meter.temp-normal { --meter-fill:#2e7d32; }.lcars-meter.temp-hot { --meter-fill:#c62828; }.lcars-meter.percentage ha-icon,.lcars-meter.temperature ha-icon { color:#fff; filter:drop-shadow(0 1px 2px #000); }.lcars-meter ha-icon { --mdc-icon-size:17px; }.lcars-meter span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.lcars-meter b { min-width:max-content; overflow:visible; font-size:14px; text-transform:uppercase; white-space:nowrap; }.lcars-meter.adjustable input { position:absolute; z-index:2; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:ew-resize; }.lcars-meter.adjustable:focus-within { outline:2px solid #aaaaff; outline-offset:-2px; }
    .lcars-standby { min-height:42px; display:flex; align-items:center; justify-content:flex-end; padding:6px 13px; border-radius:0 21px 21px 0; color:#08080a; background:#9999ff; font-size:13px; font-weight:900; line-height:1.2; text-align:right; }.lcars-standby.offline { color:#fff; background:#555962; text-shadow:0 1px 2px #000; }
    .lcars-no-devices { display:block; padding:10px 12px; color:#77738a; font-size:9px; font-weight:800; letter-spacing:.08em; text-align:right; }
    .lcars-empty { margin:45px 90px; padding:28px; border:3px solid #ff9900; border-radius:0 35px 35px 0; color:#ff9900; font-size:24px; font-weight:900; text-align:center; }
    .lcars-footer { display:grid; grid-template-columns:1fr auto 80px; align-items:center; gap:10px; margin:0 0 3px; }.lcars-footer span { height:9px; background:var(--lcars-footer-tone); }.lcars-footer b { color:var(--lcars-footer-tone); font-size:10px; letter-spacing:.08em; }.lcars-footer i { height:24px; border-radius:0 15px 15px 0; background:var(--lcars-footer-tone); }
    .lcars-weather { color:#f5f1ff; }.lcars-weather>header { display:grid; grid-template-columns:48px 232px minmax(50px,1fr) auto; align-items:stretch; height:48px; color:var(--weather-contrast); font-family:Impact,"Arial Narrow",sans-serif; font-size:22px; letter-spacing:.035em; }.lcars-weather>header>ha-icon,.lcars-weather>header>strong { display:flex; align-items:center; background:var(--weather-tone); }.lcars-weather>header>ha-icon { width:auto; padding-left:14px; border-radius:25px 0 0 0; }.lcars-weather>header>strong { padding:0 14px 0 4px; }.lcars-weather>header>i { align-self:end; margin:0 10px 7px; border-bottom:8px solid var(--weather-tone); }.lcars-weather>header>b { align-self:end; padding:8px 16px; border-radius:18px 18px 0 0; color:var(--weather-contrast); background:var(--weather-tone); text-transform:uppercase; }
    .lcars-weather-grid { position:relative; padding:14px 0 18px 76px; }.lcars-weather-grid::before { content:""; position:absolute; top:0; bottom:-12px; left:0; width:64px; background:var(--weather-tone); }
    .lcars-weather-current dt { display:flex; align-items:center; gap:7px; }.lcars-weather-current dt ha-icon { --mdc-icon-size:17px; }
    .lcars-weather-current { display:grid; grid-template-columns:170px minmax(220px,1fr) minmax(260px,.8fr); gap:22px; align-items:center; padding:28px; border:2px solid var(--weather-tone); border-radius:0 22px 22px 0; background:#0b0b10; }.weather-main-icon { justify-self:center; color:var(--weather-tone); --mdc-icon-size:120px; }.lcars-weather-current small { color:var(--weather-tone); font-size:11px; font-weight:800; letter-spacing:.12em; }.lcars-weather-current strong { display:block; margin-top:5px; font-family:Impact,"Arial Narrow",sans-serif; font-size:68px; font-weight:400; line-height:1; }.lcars-weather-current>div>span { display:block; margin-top:7px; font-family:Impact,"Arial Narrow",sans-serif; font-size:18px; text-transform:uppercase; }.lcars-weather-current dl { margin:0; }.lcars-weather-current dl>div { display:flex; justify-content:space-between; gap:20px; margin-top:7px; padding:10px 14px; border-radius:18px 0 0 18px; color:var(--weather-contrast); background:var(--weather-tone); }.lcars-weather-current dt,.lcars-weather-current dd { font-family:Impact,"Arial Narrow",sans-serif; font-size:15px; font-weight:400; letter-spacing:.035em; }.lcars-weather-current dd { margin:0; }
    .lcars-weather-panels { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-top:16px; }.lcars-weather-panel { min-width:0; overflow:hidden; border:2px solid var(--weather-tone); border-radius:0 22px 22px 0; background:#0b0b10; }.lcars-weather-panel>header { display:flex; align-items:center; gap:9px; min-height:48px; padding:0 16px; color:var(--weather-contrast); background:var(--weather-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; letter-spacing:.035em; }.lcars-weather-panel>header ha-icon { --mdc-icon-size:21px; }.lcars-weather-panel>div { padding:8px 16px 12px; }.lcars-forecast-row { display:grid; grid-template-columns:52px 25px 52px minmax(90px,1fr) 52px; align-items:center; gap:8px; min-height:42px; border-bottom:1px solid color-mix(in srgb,var(--weather-tone) 35%,transparent); }.lcars-forecast-row:last-child { border-bottom:0; }.lcars-forecast-row>b { font-family:Impact,"Arial Narrow",sans-serif; font-size:17px; font-weight:400; text-transform:uppercase; }.lcars-forecast-row ha-icon { color:var(--weather-tone); --mdc-icon-size:21px; }.lcars-forecast-row ha-icon.weather-sun,.weather-main-icon.weather-sun { color:var(--lcars-datetime,#ff9900); }.lcars-forecast-row>span,.lcars-forecast-row>em { font-style:normal; text-align:right; }.lcars-forecast-row>i { position:relative; height:13px; border-radius:999px; background:#202936; }.lcars-forecast-row>i::after { content:""; position:absolute; top:0; bottom:0; left:var(--forecast-start); width:calc(var(--forecast-end) - var(--forecast-start)); border-radius:999px; background:linear-gradient(90deg,var(--forecast-start-color,#123a8c),var(--forecast-end-color,#d32f2f)); }.lcars-weather-no-forecast,.lcars-weather-empty { display:grid; place-items:center; min-height:350px; color:var(--weather-tone,#66aacc); font-family:Impact,"Arial Narrow",sans-serif; font-size:24px; }.lcars-weather-panel .lcars-weather-no-forecast { min-height:260px; }
    .lcars-weather-history-panels { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-top:16px; }.lcars-weather-history-panel { min-width:0; overflow:hidden; border:2px solid var(--weather-tone); border-radius:0 22px 22px 0; background:#0b0b10; }.lcars-weather-history-panel>header { display:flex; align-items:center; gap:9px; min-height:48px; padding:0 16px; color:var(--weather-contrast); background:var(--weather-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; font-weight:400; letter-spacing:.035em; }.lcars-weather-history-panel>header ha-icon { --mdc-icon-size:21px; }.lcars-weather-history-card { min-height:330px; overflow:hidden; background:#050507; }.lcars-weather-history-card>* { display:block; --ha-card-border-width:0; --ha-card-border-radius:0; --ha-card-box-shadow:none; --graph-color-1:var(--weather-tone)!important; --graph-color-2:#9999ff!important; --graph-color-3:#ff9966!important; --accent-color:var(--weather-tone)!important; --primary-color:var(--weather-tone)!important; --card-background-color:#0b0b10!important; --ha-card-background:#0b0b10!important; --primary-text-color:#f5f1ff; --secondary-text-color:#c9c2d8; color-scheme:dark; }.lcars-weather-history-error { display:grid; place-items:center; min-height:330px; color:var(--weather-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; }
    .lcars-security { color:#f5f1ff; }.lcars-security>header { display:grid; grid-template-columns:48px 232px minmax(50px,1fr) auto; align-items:stretch; height:48px; color:var(--security-contrast); font-family:Impact,"Arial Narrow",sans-serif; font-size:22px; letter-spacing:.035em; }.lcars-security>header>ha-icon,.lcars-security>header>strong { display:flex; align-items:center; background:var(--security-tone); }.lcars-security>header>ha-icon { width:auto; padding-left:14px; border-radius:25px 0 0 0; }.lcars-security>header>strong { padding:0 14px 0 4px; }.lcars-security>header>i { align-self:end; margin:0 10px 7px; border-bottom:8px solid var(--security-tone); }.lcars-security>header>b { align-self:end; padding:8px 16px; border-radius:18px 18px 0 0; color:var(--security-contrast); background:var(--security-tone); text-transform:uppercase; }
    .lcars-security-grid { position:relative; padding:14px 0 18px 76px; }.lcars-security-grid::before { content:""; position:absolute; top:0; bottom:-12px; left:0; width:64px; background:var(--security-tone); }.lcars-camera-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }.lcars-camera-panel { min-width:0; overflow:hidden; border:2px solid var(--security-tone); border-radius:0 22px 22px 0; background:#0b0b10; }.lcars-camera-panel>header { display:grid; grid-template-columns:24px minmax(0,1fr) auto; align-items:center; gap:9px; min-height:48px; padding:0 16px; color:var(--security-contrast); background:var(--security-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; letter-spacing:.035em; }.lcars-camera-panel>header ha-icon { --mdc-icon-size:21px; }.lcars-camera-panel>header strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.lcars-camera-panel>header b { font-size:14px; font-weight:400; text-transform:uppercase; }.lcars-camera-card { min-height:260px; overflow:hidden; background:#050507; }.lcars-camera-card>* { display:block; --ha-card-border-width:0; --ha-card-border-radius:0; --ha-card-box-shadow:none; }.lcars-camera-error { display:grid; place-items:center; min-height:260px; color:var(--security-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; }
    .lcars-engineering { color:#f5f1ff; }.lcars-engineering>header { display:grid; grid-template-columns:48px 232px minmax(50px,1fr) auto; align-items:stretch; height:48px; color:var(--engineering-contrast); font-family:Impact,"Arial Narrow",sans-serif; font-size:22px; letter-spacing:.035em; }.lcars-engineering>header>ha-icon,.lcars-engineering>header>strong { display:flex; align-items:center; background:var(--engineering-tone); }.lcars-engineering>header>ha-icon { width:auto; padding-left:14px; border-radius:25px 0 0 0; }.lcars-engineering>header>strong { padding:0 14px 0 4px; }.lcars-engineering>header>i { align-self:end; margin:0 10px 7px; border-bottom:8px solid var(--engineering-tone); }.lcars-engineering>header>b { align-self:end; padding:8px 16px; border-radius:18px 18px 0 0; color:var(--engineering-contrast); background:var(--engineering-tone); text-transform:uppercase; }
    .lcars-engineering-grid { position:relative; padding:14px 0 18px 76px; }.lcars-engineering-grid::before { content:""; position:absolute; top:0; bottom:-12px; left:0; width:64px; background:var(--engineering-tone); }.lcars-engineering-panels { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }.lcars-engineering-panel { min-width:0; overflow:hidden; border:2px solid var(--engineering-tone); border-radius:0 22px 22px 0; background:#0b0b10; }.lcars-engineering-panel>header { display:flex; align-items:center; gap:9px; min-height:48px; padding:0 16px; color:var(--engineering-contrast); background:var(--engineering-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; letter-spacing:.035em; }.lcars-engineering-panel>header ha-icon { --mdc-icon-size:21px; }.lcars-engineering-card { min-height:300px; overflow:hidden; background:#050507; }.lcars-engineering-card>* { display:block; --ha-card-border-width:0; --ha-card-border-radius:0; --ha-card-box-shadow:none; }.lcars-engineering-error { display:grid; place-items:center; min-height:300px; color:var(--engineering-tone); font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; }
    .lcars-weather-current dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }.lcars-weather-current dl>div { min-width:0; margin-top:0; }.lcars-weather-current dd { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .lcars-engineering-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:16px; }.lcars-engineering-metrics article { min-width:0; display:flex; align-items:center; gap:12px; min-height:72px; padding:10px 16px; border:2px solid color-mix(in srgb,var(--engineering-tone) 60%,#30303a); border-radius:24px; background:linear-gradient(115deg,color-mix(in srgb,var(--engineering-tone) 16%,#0b0b10),#161721); }.lcars-engineering-metrics article>ha-icon { flex:0 0 28px; color:var(--engineering-tone); --mdc-icon-size:28px; }.lcars-engineering-metrics article>div { min-width:0; }.lcars-engineering-metrics strong,.lcars-engineering-metrics span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.lcars-engineering-metrics strong { font-family:Impact,"Arial Narrow",sans-serif; font-size:18px; font-weight:400; letter-spacing:.035em; }.lcars-engineering-metrics span { margin-top:3px; font-size:14px; }
    .lcars-engineering-card>* { --graph-color-1:var(--engineering-chart)!important; --graph-color-2:var(--engineering-chart-secondary)!important; --graph-color-3:var(--engineering-chart-tertiary)!important; --accent-color:var(--engineering-chart)!important; --primary-color:var(--engineering-chart)!important; --state-icon-color:var(--engineering-chart)!important; --card-background-color:#0b0b10!important; --ha-card-background:#0b0b10!important; --primary-text-color:#f5f1ff; --secondary-text-color:#b9b2c8; --divider-color:color-mix(in srgb,var(--engineering-tone) 35%,#252531); color-scheme:dark; }
    .lcars-engineering>header,.lcars-engineering-panel>header { text-shadow:0 1px 2px rgba(0,0,0,.65); }
    .lcars-captains-log .lcars-engineering-panels { grid-template-columns:1fr; }
    .lcars-captains-log-card { min-height:620px; }
    .lcars-captains-log-card>* { --primary-color:var(--engineering-tone)!important; --accent-color:var(--engineering-tone)!important; --state-icon-color:var(--engineering-tone)!important; --card-background-color:#0b0b10!important; --ha-card-background:#0b0b10!important; --primary-text-color:#f5f1ff; --secondary-text-color:#c9c2d8; color-scheme:dark; }
    .lcars-popup-backdrop { position:fixed; z-index:1000; inset:0; display:grid; place-items:center; padding:22px; background:rgba(0,0,0,.72); backdrop-filter:blur(3px); }
    .lcars-popup { width:min(820px,calc(100vw - 44px)); max-height:calc(100vh - 44px); overflow:auto; color:#eee8fa; background:#07070a; border:3px solid #9999ff; border-radius:0 34px 34px 0; box-shadow:0 18px 70px #000; }
    .lcars-popup-top { display:grid; grid-template-columns:1fr auto 54px; align-items:center; height:48px; color:#fff; background:#9999ff; font-family:Impact,"Arial Narrow",sans-serif; font-size:18px; letter-spacing:.04em; }
    .lcars-popup-top span { padding:0 15px; }.lcars-popup-top button { align-self:stretch; border:0; border-radius:0 25px 25px 0; color:#fff; background:#9999ff; font:inherit; font-size:27px; cursor:pointer; }
    .lcars-popup>header { display:grid; grid-template-columns:42px minmax(0,1fr) auto; align-items:center; gap:12px; margin:13px 16px 0; padding:13px 17px; color:#fff; background:#cc99cc; }
    .lcars-popup>header ha-icon { --mdc-icon-size:30px; }.lcars-popup>header h2 { margin:2px 0 0; font-family:Impact,"Arial Narrow",sans-serif; font-size:27px; font-weight:400; letter-spacing:.025em; text-transform:uppercase; }.lcars-popup>header small { margin:0; color:rgba(255,255,255,.78); font-size:11px; }.lcars-popup>header>b { padding:8px 13px; border-radius:999px; color:#fff; background:#2e7d32; font-size:18px; white-space:nowrap; }
    .lcars-popup-body { display:grid; grid-template-columns:48px minmax(0,1fr); gap:12px; margin:0 16px; }.lcars-popup-rail { position:relative; background:#cc99cc; }.lcars-popup-rail::after { content:""; position:absolute; right:0; bottom:-12px; left:0; height:12px; background:#cc99cc; }.lcars-history { min-height:310px; padding:12px 0; }.lcars-history hui-history-graph-card { display:block; color:var(--primary-text-color,#fff); }
    .lcars-history-error { display:grid; place-items:center; min-height:286px; color:#ff9966; font-family:Impact,"Arial Narrow",sans-serif; font-size:20px; letter-spacing:.04em; }
    .lcars-popup>footer { display:grid; grid-template-columns:1fr auto 65px; align-items:center; gap:9px; margin:0 16px 14px; }.lcars-popup>footer span { height:9px; background:#cc99cc; }.lcars-popup>footer b { color:#cc99cc; font-size:10px; letter-spacing:.08em; }.lcars-popup>footer i { height:24px; border-radius:0 14px 14px 0; background:#ff9966; }
    .message { min-height:160px; display:flex; align-items:center; justify-content:center; gap:10px; color:var(--secondary-text-color,#727272); text-align:center; }
    .message.error { color:var(--error-color,#db4437); }
    .spinner { width:22px; height:22px; border:2px solid var(--divider-color,#ddd); border-top-color:var(--at-accent); border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (max-width:1200px) { .standalone-lcars .lcars-area-grid { grid-template-columns:1fr; } }
    @media (max-width:1100px) { .lcars-weather-panels,.lcars-weather-history-panels,.lcars-camera-grid,.lcars-engineering-panels { grid-template-columns:1fr; }.lcars-engineering-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:900px) { .lcars-weather-grid,.lcars-security-grid,.lcars-engineering-grid { padding-left:30px; }.lcars-weather-grid::before,.lcars-security-grid::before,.lcars-engineering-grid::before { width:22px; }.lcars-weather-current { grid-template-columns:110px 1fr; }.weather-main-icon { --mdc-icon-size:82px; }.lcars-weather-current dl { grid-column:1 / -1; }.lcars-weather-current strong { font-size:52px; } }
    @media (max-width:700px) { .header-main { align-items:flex-start; } .header-actions button { padding:7px; } .workspace { flex-direction:column; } .topology-scroll { width:100%; cursor:grab; } .unassigned-panel { width:100%; height:min(42vh,420px); border-left:0; border-top:1px solid var(--divider-color,#ddd); } .lcars-masthead { grid-template-columns:38px 1fr 28px; grid-template-rows:48px 42px; }.lcars-title { justify-content:flex-start; }.lcars-title strong { font-size:21px; }.lcars-clock { grid-column:1 / 2; justify-content:flex-end; padding:8px 6px; font-size:18px; }.lcars-date { grid-column:2 / 4; justify-content:flex-start; padding:8px 10px; font-size:16px; }.lcars-end { grid-column:3; grid-row:1; }.lcars-body { display:block; }.lcars-floor-nav { position:sticky; top:0; flex-direction:row; overflow-x:auto; margin:0 -4px 8px; padding:6px 4px; background:#050507; }.lcars-nav-cap,.lcars-nav-foot { display:none; }.lcars-floor-nav button { flex:0 0 auto; grid-template-columns:38px auto; min-height:38px; }.lcars-floor-nav button span,.lcars-floor-nav button b { height:38px; }.lcars-floor-nav button span { font-size:19px; }.lcars-floor-nav button b { max-width:150px; font-size:12px; }.lcars-floor { scroll-margin-top:58px; }.lcars-floor>header { grid-template-columns:minmax(190px,auto) 1fr; }.lcars-floor>header b { display:none; }.lcars-area-grid { --lcars-area-rail:22px; --lcars-area-rail-gap:8px; grid-template-columns:1fr; grid-auto-rows:auto; margin-left:0; }.lcars-area { grid-row:auto!important; }.lcars-device { grid-template-columns:1fr; padding-right:0; }.lcars-device-name,.lcars-meter,.lcars-standby { border-radius:12px; }.lcars-footer { margin-left:0; } }
  `; }
}

if (!customElements.get("area-topology-card")) customElements.define("area-topology-card", AreaTopologyCard);

class LcarsHomeCard extends AreaTopologyCard {
  setConfig(config) {
    this._standaloneLcars = true;
    super.setConfig({
      ...config,
      layout: "lcars",
      show_only_labeled: true,
      show_unassigned: false,
      initial_label_selection: "all",
    });
    this._layoutMode = "lcars";
    this._labelsOnly = true;
    this._showUnassigned = false;
    this.render();
  }

  static getStubConfig() {
    return { title: "Home" };
  }
}

if (!customElements.get("lcars-home-card")) customElements.define("lcars-home-card", LcarsHomeCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "area-topology-card",
  name: "Area Topology",
  description: "A network-style map of Home Assistant areas and devices.",
  preview: true,
});
window.customCards.push({
  type: "lcars-home-card",
  name: "LCARS Home Dashboard",
  description: "A standalone LCARS dashboard for labelled Home Assistant devices.",
  preview: true,
});
console.info(`%c AREA-TOPOLOGY-CARD %c v${CARD_VERSION} · ${BUILD_COMMIT} `, "color:white;background:#03a9f4;font-weight:bold", "color:#03a9f4;background:#eee");
