const CARD_VERSION = "1.1.0";

const DEFAULTS = {
  title: "Home topology",
  show_unassigned: false,
  show_only_labeled: true,
  show_entities: false,
  web_show_properties: undefined,
  tree_show_properties: true,
  show_status: true,
  max_statuses: 3,
  topology_zoom: 1,
  web_zoom: undefined,
  tree_font_scale: 1,
  layout: "web",
  floors_expanded: true,
  areas_expanded: true,
  tree_devices_expanded: false,
  map_height: "auto",
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
    devices: [],
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
    const preferenceKey = `area-topology-card:${window.location.pathname}:${this._config.title}`;
    if (this._preferenceKey !== preferenceKey) {
      this._preferenceKey = preferenceKey;
      const preferences = this.loadPreferences();
      this._showUnassigned = preferences.showUnassigned ?? this._config.show_unassigned;
      this._labelsOnly = preferences.labelsOnly ?? this._config.show_only_labeled;
      this._unassignedLabelsOnly = preferences.unassignedLabelsOnly ?? false;
      this._unassignedSearch = preferences.unassignedSearch ?? "";
      this._layoutMode = preferences.layoutMode === "tree" || (!preferences.layoutMode && this._config.layout === "tree") ? "tree" : "web";
    }
    if (this._webZoom === undefined) this._webZoom = Math.max(0.65, Math.min(1.8, Number(config.web_zoom ?? config.topology_zoom) || 1));
    if (this._treeScale === undefined) this._treeScale = Math.max(0.65, Math.min(1.8, Number(this._config.tree_font_scale) || 1));
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
      this.render();
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
      if (!this._selectedLabels) this._selectedLabels = new Set(labels.map((label) => label.label_id));
      this._data = buildTopology(areas, devices, entities, labels, true, floors);
      if (!this._hierarchyDefaultsInitialized) {
        if (!this._config.areas_expanded) this._collapsedAreas = new Set(this._data.filter((area) => area.id !== "__unassigned__").map((area) => area.id));
        if (!this._config.floors_expanded && this.hasFloorLevel()) this._collapsedFloors = new Set(this.floorGroups().map((floor) => floor.id));
        if (this._config.tree_devices_expanded && this._config.tree_show_properties) {
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
    if (this._eventsBound) return;
    this._eventsBound = true;
    this.shadowRoot.addEventListener("scroll", (event) => {
      if (event.target.classList?.contains("unassigned-list")) {
        this._unassignedScrollTop = event.target.scrollTop;
      }
    }, true);
    this.shadowRoot.addEventListener("input", (event) => {
      if (!event.target.matches?.("[data-unassigned-search]")) return;
      this._unassignedSearch = event.target.value;
      this._restoreUnassignedSearchFocus = true;
      this.savePreferences();
      this.render();
    });
    this.shadowRoot.addEventListener("click", (event) => {
      if (Date.now() < (this._suppressDeviceClickUntil || 0) && event.target.closest("[data-device-drag]")) {
        event.preventDefault();
        return;
      }
      const action = event.target.closest("[data-topology-action]")?.dataset.topologyAction;
      if (action === "expand") {
        this.captureViewportFocus();
        this._collapsedAreas.clear();
        this._collapsedFloors.clear();
        this._expandedTreeDevices = new Set(this._data?.flatMap((area) => area.devices.map((device) => device.id)) || []);
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
        this.render();
        return;
      }
      if (action === "layout-web" || action === "layout-tree") {
        this._layoutMode = action === "layout-tree" ? "tree" : "web";
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
        this.render();
        return;
      }
      const labelId = event.target.closest("[data-label-toggle]")?.dataset.labelToggle;
      if (labelId) {
        this._selectedLabels ||= new Set();
        this._selectedLabels.has(labelId) ? this._selectedLabels.delete(labelId) : this._selectedLabels.add(labelId);
        this.collapseTreeProperties();
        this.centerWebAfterFilter();
        this.render();
        return;
      }
      const areaId = event.target.closest("[data-area-toggle]")?.dataset.areaToggle;
      if (areaId) {
        this.captureViewportFocus();
        this._collapsedAreas.has(areaId) ? this._collapsedAreas.delete(areaId) : this._collapsedAreas.add(areaId);
        this.render();
        return;
      }
      const floorId = event.target.closest("[data-floor-toggle]")?.dataset.floorToggle;
      if (floorId) {
        this.captureViewportFocus();
        this._collapsedFloors.has(floorId) ? this._collapsedFloors.delete(floorId) : this._collapsedFloors.add(floorId);
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
        this.render();
        return;
      }
      const target = event.target.closest("[data-entity]");
      if (target) {
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

  setZoom(value, clientX, clientY) {
    const nextZoom = Math.round(Math.max(0.65, Math.min(1.8, value)) * 10) / 10;
    if (nextZoom === this.currentScale()) return;
    if (this._layoutMode === "web") this.captureViewportFocus(clientX, clientY);
    if (this._layoutMode === "tree") this._treeScale = nextZoom;
    else this._webZoom = nextZoom;
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
          ? (this._layoutMode === "tree" ? this.renderTree() : this.renderAreas())
          : '<div class="message">Waiting for Home Assistant…</div>';

    this.shadowRoot.innerHTML = `
      <style>${this.styles()}</style>
      <ha-card>
        <div class="header">
          <div class="header-main">
            <div><h1>Home Topology</h1><p>${this.summary()}</p></div>
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
        </div>
        <div class="content">${content}</div>
      </ha-card>`;
    const newScroller = this.shadowRoot.querySelector(".topology-scroll");
    const newTreeScroller = this.shadowRoot.querySelector(".tree-scroll");
    const newUnassignedList = this.shadowRoot.querySelector(".unassigned-list");
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
        const color = safeColor(label.color);
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
    })).sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
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
        <div class="tree-copy"><strong>${escapeHtml(this._config.title)}</strong></div>
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
          <span class="tree-copy"><strong>${escapeHtml(floor.name)}</strong><small>${floor.areas.length} area${floor.areas.length === 1 ? "" : "s"}</small></span>
        </button>
      </div>
      ${collapsed ? "" : `<div class="tree-children">${floor.areas.map((area) => this.renderTreeArea(area)).join("")}</div>`}
    </div>`;
  }

  renderTreeArea(area) {
    const collapsed = this._collapsedAreas.has(area.id);
    const devices = this.devicesForDisplay(area);
    return `<div class="tree-branch tree-area-branch">
      <div class="tree-row tree-area" data-area-drop="${escapeHtml(area.id)}">
        <button class="tree-toggle" data-area-toggle="${escapeHtml(area.id)}" title="${collapsed ? "Expand" : "Collapse"} ${escapeHtml(area.name)}">${collapsed ? "+" : "−"}</button>
        <button class="tree-main" data-area-config="${escapeHtml(area.id)}" title="Open ${escapeHtml(area.name)} settings">
          <span class="tree-node-icon"><ha-icon icon="${escapeHtml(area.icon)}"></ha-icon></span>
          <span class="tree-copy"><strong>${escapeHtml(area.name)}</strong><small>${devices.length} device${devices.length === 1 ? "" : "s"}</small></span>
        </button>
      </div>
      ${collapsed ? "" : `<div class="tree-children">${devices.map((device) => this.renderTreeDevice(device)).join("")}</div>`}
    </div>`;
  }

  renderTreeDevice(device) {
    const collapsed = !this._expandedTreeDevices.has(device.id);
    const color = safeColor(device.color);
    const metadata = [device.manufacturer, device.model].filter(Boolean).join(" · ");
    const propertyEntities = this._config.tree_show_properties ? device.entities : [];
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
          const labelColor = safeColor(label.color, color);
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
          const labelColor = safeColor(label.color, color);
          return `<span style="--label-color:${labelColor};--label-contrast:${contrastColor(labelColor)}">${escapeHtml(label.name)}</span>`;
        }).join("")}</span>` : ""}
      </button>
    </article>`;
  }

  renderLine(from, to, className, color = "") {
    const style = color ? ` style="--line-color:${color}"` : "";
    return `<line class="${className}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"${style}/>`;
  }

  nodeStyle(point, canvas) {
    return `--x:${point.x / canvas.width * 100}%;--y:${point.y / canvas.height * 100}%`;
  }

  renderDevice(device, point, canvas) {
    const entityRows = this._config.web_show_properties && device.entities.length
      ? `<div class="entities">${device.entities.map((entity) => {
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
      ${statuses.length ? `<div class="statuses">${statuses.map((status) => `<button data-entity="${escapeHtml(status.entityId)}" class="status ${status.active ? "active" : ""}" title="${escapeHtml(status.name)}">
        <ha-icon icon="${escapeHtml(status.icon)}"></ha-icon><span>${escapeHtml(status.value)}</span>
      </button>`).join("")}</div>` : ""}
      ${device.labels.length ? `<div class="labels">${device.labels.map((label) => {
        const color = safeColor(label.color, deviceColor);
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
      if (!stateObj || ["unavailable", "unknown"].includes(stateObj.state)) continue;
      const domain = entity.entity_id.split(".")[0];
      const deviceClass = stateObj.attributes.device_class || entity.device_class || entity.original_device_class || "";
      const status = this.statusForEntity(entity, stateObj, domain, deviceClass, isPlug);
      if (status) statuses.push(status);
    }
    statuses.sort((a, b) => a.priority - b.priority);
    const limit = Math.max(1, Math.min(8, Number(this._config.max_statuses) || 3));
    return statuses.slice(0, limit);
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
      return { ...common, priority: 2, active: on, value: on ? "On" : "Off", icon: on ? "mdi:lightbulb-on" : "mdi:lightbulb-outline" };
    }
    if (domain === "switch" && (deviceClass === "outlet" || isPlug)) {
      return { ...common, priority: 2, active: on, value: on ? "On" : "Off", icon: on ? "mdi:power-plug" : "mdi:power-plug-off" };
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
    .header p { color:var(--secondary-text-color,#727272); margin:5px 0 0; font-size:13px; }
    .header-main>ha-icon { color:var(--at-accent); --mdc-icon-size:30px; }
    .header-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:7px; }
    .header-actions button { display:flex; align-items:center; gap:5px; padding:7px 10px; border:1px solid var(--divider-color,#ddd); border-radius:9px; color:var(--primary-text-color,#222); background:var(--secondary-background-color,#f1f1f1); font:inherit; font-size:12px; cursor:pointer; }
    .header-actions button:hover { border-color:var(--at-accent); color:var(--at-accent); }
    .header-actions span { font-size:17px; line-height:10px; }
    .layout-controls { display:flex; align-items:stretch; }
    .header-actions .layout-controls button { padding:5px 8px; border-radius:0; }
    .header-actions .layout-controls button:first-child { border-radius:9px 0 0 9px; }
    .header-actions .layout-controls button+button { margin-left:-1px; border-radius:0 9px 9px 0; }
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
    .tree-toggle.empty { opacity:.25; cursor:default; }
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
    .message { min-height:160px; display:flex; align-items:center; justify-content:center; gap:10px; color:var(--secondary-text-color,#727272); text-align:center; }
    .message.error { color:var(--error-color,#db4437); }
    .spinner { width:22px; height:22px; border:2px solid var(--divider-color,#ddd); border-top-color:var(--at-accent); border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (max-width:700px) { .header-main { align-items:flex-start; } .header-actions button { padding:7px; } .workspace { flex-direction:column; } .topology-scroll { width:100%; cursor:grab; } .unassigned-panel { width:100%; height:min(42vh,420px); border-left:0; border-top:1px solid var(--divider-color,#ddd); } }
  `; }
}

if (!customElements.get("area-topology-card")) customElements.define("area-topology-card", AreaTopologyCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "area-topology-card",
  name: "Area Topology",
  description: "A network-style map of Home Assistant areas and devices.",
  preview: true,
});
console.info(`%c AREA-TOPOLOGY-CARD %c v${CARD_VERSION} `, "color:white;background:#03a9f4;font-weight:bold", "color:#03a9f4;background:#eee");
