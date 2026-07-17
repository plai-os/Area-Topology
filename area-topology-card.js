const CARD_VERSION = "0.8.2";

const DEFAULTS = {
  title: "Home topology",
  show_unassigned: false,
  show_only_labeled: true,
  show_entities: false,
  show_status: true,
  max_statuses: 3,
  topology_zoom: 1,
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

export function buildTopology(areas, devices, entities, labels, showUnassigned = true) {
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
  }

  setConfig(config) {
    this._config = { ...DEFAULTS, ...config };
    if (this._showUnassigned === undefined) this._showUnassigned = this._config.show_unassigned;
    if (this._labelsOnly === undefined) this._labelsOnly = this._config.show_only_labeled;
    if (this._zoom === undefined) this._zoom = Math.max(0.65, Math.min(1.8, Number(this._config.topology_zoom) || 1));
    this.render();
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
      const [areas, devices, entities, labels] = await Promise.all([
        call("config/area_registry/list"),
        call("config/device_registry/list"),
        call("config/entity_registry/list"),
        call("config/label_registry/list"),
      ]);
      this._labels = labels;
      if (!this._selectedLabels) this._selectedLabels = new Set(labels.map((label) => label.label_id));
      this._data = buildTopology(areas, devices, entities, labels, true);
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
    this.shadowRoot.addEventListener("click", (event) => {
      const action = event.target.closest("[data-topology-action]")?.dataset.topologyAction;
      if (action === "expand") {
        this._collapsedAreas.clear();
        this.render();
        return;
      }
      if (action === "collapse") {
        this._collapsedAreas = new Set(this._data?.map((area) => area.id) || []);
        this.render();
        return;
      }
      if (action === "zoom-in") {
        this.setZoom(this._zoom + 0.1);
        return;
      }
      if (action === "zoom-out") {
        this.setZoom(this._zoom - 0.1);
        return;
      }
      if (action === "zoom-reset") {
        this.setZoom(Number(this._config.topology_zoom) || 1);
        return;
      }
      if (action === "unassigned") {
        this._showUnassigned = !this._showUnassigned;
        this.render();
        return;
      }
      if (action === "labels") {
        this._labelsOnly = !this._labelsOnly;
        this.render();
        return;
      }
      if (action === "all-labels") {
        const allSelected = this._selectedLabels?.size === this._labels?.length;
        this._selectedLabels = new Set(allSelected ? [] : (this._labels || []).map((label) => label.label_id));
        this.render();
        return;
      }
      const labelId = event.target.closest("[data-label-toggle]")?.dataset.labelToggle;
      if (labelId) {
        this._selectedLabels ||= new Set();
        this._selectedLabels.has(labelId) ? this._selectedLabels.delete(labelId) : this._selectedLabels.add(labelId);
        this.render();
        return;
      }
      const areaId = event.target.closest("[data-area-toggle]")?.dataset.areaToggle;
      if (areaId) {
        this._collapsedAreas.has(areaId) ? this._collapsedAreas.delete(areaId) : this._collapsedAreas.add(areaId);
        this.render();
        return;
      }
      const areaConfigId = event.target.closest("[data-area-config]")?.dataset.areaConfig;
      if (areaConfigId) {
        this.navigate(`/config/areas/area/${encodeURIComponent(areaConfigId)}`);
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
      const device = event.target.closest("[data-unassigned-device]");
      if (!device || !event.dataTransfer) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", device.dataset.unassignedDevice);
      device.classList.add("dragging");
    });
    this.shadowRoot.addEventListener("dragend", (event) => {
      event.target.closest("[data-unassigned-device]")?.classList.remove("dragging");
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
    if (nextZoom === this._zoom) return;
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
    this._zoom = nextZoom;
    this.render();
  }

  render() {
    if (!this.shadowRoot || !this._config) return;
    const oldScroller = this.shadowRoot.querySelector(".topology-scroll");
    const previousScroll = oldScroller ? { left: oldScroller.scrollLeft, top: oldScroller.scrollTop } : null;
    const content = this._loading
      ? '<div class="message"><span class="spinner"></span>Reading Home Assistant registries…</div>'
      : this._error
        ? `<div class="message error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><div><strong>Could not load topology</strong><br>${escapeHtml(this._error)}</div></div>`
        : this._data
          ? this.renderAreas()
          : '<div class="message">Waiting for Home Assistant…</div>';

    this.shadowRoot.innerHTML = `
      <style>${this.styles()}</style>
      <ha-card>
        <div class="header">
          <div class="header-main">
            <div><h1>Area topology</h1><p>${this.summary()}</p></div>
            ${this._data ? `<div class="header-actions">
              <button data-topology-action="expand" title="Expand all areas"><span>＋</span> Expand all</button>
              <button data-topology-action="collapse" title="Collapse to areas"><span>−</span> Collapse all</button>
              <div class="zoom-controls" aria-label="Topology zoom">
                <button data-topology-action="zoom-out" title="Zoom out">−</button>
                <button class="zoom-level" data-topology-action="zoom-reset" title="Reset zoom">${Math.round(this._zoom * 100)}%</button>
                <button data-topology-action="zoom-in" title="Zoom in">＋</button>
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
    if (newScroller) requestAnimationFrame(() => {
      if (this._zoomFocus) {
        newScroller.scrollLeft = this._zoomFocus.x * newScroller.scrollWidth - this._zoomFocus.focusX;
        newScroller.scrollTop = this._zoomFocus.y * newScroller.scrollHeight - this._zoomFocus.focusY;
        this._zoomFocus = null;
      } else if (previousScroll) {
        newScroller.scrollLeft = previousScroll.left;
        newScroller.scrollTop = previousScroll.top;
      } else {
        newScroller.scrollLeft = Math.max(0, (newScroller.scrollWidth - newScroller.clientWidth) / 2);
        newScroller.scrollTop = Math.max(0, (newScroller.scrollHeight - newScroller.clientHeight) / 2);
      }
    });
  }

  summary() {
    if (!this._data) return "Areas and their connected devices";
    const deviceCount = this._data.reduce((total, area) => total + area.devices.length, 0);
    const areaCount = this._data.filter((area) => area.id !== "__unassigned__").length;
    return `${areaCount} area${areaCount === 1 ? "" : "s"} · ${deviceCount} device${deviceCount === 1 ? "" : "s"}`;
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

  renderAreas() {
    const visibleAreas = this._data.filter((area) => area.id !== "__unassigned__");
    if (!visibleAreas.length) return '<div class="message">No areas or devices found.</div>';
    const sector = Math.PI * 2 / visibleAreas.length;
    const areaRadius = Math.max(285, visibleAreas.length * 190 / (Math.PI * 2));
    const areaLayouts = [];
    let maximumRadius = areaRadius;

    visibleAreas.forEach((area, areaIndex) => {
      const angle = -Math.PI / 2 + areaIndex * sector;
      const devices = [];
      const allLabelsSelected = this._selectedLabels?.size === this._labels?.length;
      const displayedDevices = area.devices.filter((device) => {
        if (this._labelsOnly && !device.labels.length) return false;
        if (allLabelsSelected) return true;
        return device.labels.some((label) => this._selectedLabels?.has(label.label_id));
      });
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
        lines.push(this.renderLine(areaPoint, point, "device-line"));
        deviceNodes.push(this.renderDevice(device, point, canvas));
      });
    });

    const requestedHeight = Number(this._config.map_height);
    const mapHeight = Number.isFinite(requestedHeight) && requestedHeight > 0
      ? `${Math.max(360, Math.min(1400, requestedHeight))}px`
      : "clamp(420px, calc(100vh - 230px), 1200px)";
    const scaledWidth = Math.round(canvas.width * this._zoom);
    const scaledHeight = Math.round(canvas.height * this._zoom);
    return `<div class="workspace" style="--map-height:${mapHeight}"><div class="topology-scroll"><div class="topology-canvas" style="width:${scaledWidth}px;height:${scaledHeight}px"><div class="topology" style="width:${canvas.width}px;height:${canvas.height}px;--zoom:${this._zoom}">
      <svg class="web" viewBox="0 0 ${canvas.width} ${canvas.height}" preserveAspectRatio="none" aria-hidden="true">
        ${lines.join("")}
      </svg>
      <div class="home node" style="${this.nodeStyle(center, canvas)}">
        <span class="home-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3 2.5 11.1l1.3 1.5L5 11.5V21h5v-6h4v6h5v-9.5l1.2 1.1 1.3-1.5L12 3Zm5 16h-1v-6H8v6H7v-9.2l5-4.3 5 4.3V19Z"/></svg>
        </span>
        <strong>${escapeHtml(this._config.title)}</strong>
        <small>${this.summary()}</small>
      </div>
      ${areaNodes.join("")}
      ${deviceNodes.join("")}
    </div></div></div>${this.renderUnassignedPanel()}</div>`;
  }

  renderUnassignedPanel() {
    if (!this._showUnassigned) return "";
    const unassigned = this._data.find((area) => area.id === "__unassigned__");
    const devices = unassigned?.devices || [];
    return `<aside class="unassigned-panel">
      <div class="panel-head">
        <div><h2>Unassigned</h2><small>${devices.length} device${devices.length === 1 ? "" : "s"}</small></div>
        <ha-icon icon="mdi:tray-arrow-right"></ha-icon>
      </div>
      <p class="panel-help">Drag a device onto an area to assign it.</p>
      ${this._assignmentMessage ? `<div class="assignment-message ${this._assignmentMessage.type}">${escapeHtml(this._assignmentMessage.text)}</div>` : ""}
      <div class="unassigned-list">
        ${devices.length ? devices.map((device) => this.renderUnassignedDevice(device)).join("") : '<div class="panel-empty">No unassigned devices</div>'}
      </div>
    </aside>`;
  }

  renderUnassignedDevice(device) {
    const color = safeColor(device.color);
    const metadata = [device.manufacturer, device.model].filter(Boolean).join(" · ");
    return `<article class="unassigned-device" draggable="true" data-unassigned-device="${escapeHtml(device.id)}" style="--device-color:${color}">
      <span class="drag-handle" title="Drag to an area">⋮⋮</span>
      <span class="device-icon"><ha-icon icon="${escapeHtml(device.icon)}"></ha-icon></span>
      <button data-device="${escapeHtml(device.id)}" title="Open ${escapeHtml(device.name)} settings">
        <strong>${escapeHtml(device.name)}</strong>${metadata ? `<small>${escapeHtml(metadata)}</small>` : ""}
      </button>
    </article>`;
  }

  renderLine(from, to, className) {
    return `<line class="${className}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>`;
  }

  nodeStyle(point, canvas) {
    return `--x:${point.x / canvas.width * 100}%;--y:${point.y / canvas.height * 100}%`;
  }

  renderDevice(device, point, canvas) {
    const entityRows = this._config.show_entities && device.entities.length
      ? `<div class="entities">${device.entities.map((entity) => {
          const state = this._hass?.states?.[entity.entity_id];
          return `<button data-entity="${escapeHtml(entity.entity_id)}"><span>${escapeHtml(state?.attributes?.friendly_name || entity.name || entity.original_name || entity.entity_id)}</span><b>${escapeHtml(state?.state || "unavailable")}</b></button>`;
        }).join("")}</div>` : "";
    const metadata = [device.manufacturer, device.model].filter(Boolean).join(" · ");
    const deviceColor = safeColor(device.color);
    const statuses = this._config.show_status ? this.deviceStatuses(device) : [];
    return `<article class="device node" data-device="${escapeHtml(device.id)}" title="Open ${escapeHtml(device.name)} settings" style="${this.nodeStyle(point, canvas)};--device-color:${deviceColor}">
      <div class="device-main">
        <span class="device-icon"><ha-icon icon="${escapeHtml(device.icon)}"></ha-icon></span>
        <div class="device-copy"><h3>${escapeHtml(device.name)}</h3>${metadata ? `<small>${escapeHtml(metadata)}</small>` : ""}</div>
      </div>
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
    for (const entity of device.entities) {
      const stateObj = this._hass?.states?.[entity.entity_id];
      if (!stateObj || ["unavailable", "unknown"].includes(stateObj.state)) continue;
      const domain = entity.entity_id.split(".")[0];
      const deviceClass = stateObj.attributes.device_class || entity.device_class || entity.original_device_class || "";
      const status = this.statusForEntity(entity, stateObj, domain, deviceClass);
      if (status) statuses.push(status);
    }
    statuses.sort((a, b) => a.priority - b.priority);
    const limit = Math.max(1, Math.min(8, Number(this._config.max_statuses) || 3));
    return statuses.slice(0, limit);
  }

  statusForEntity(entity, stateObj, domain, deviceClass) {
    const on = stateObj.state === "on";
    const formatted = () => this._hass?.formatEntityState?.(stateObj)
      || `${stateObj.state}${stateObj.attributes.unit_of_measurement ? ` ${stateObj.attributes.unit_of_measurement}` : ""}`;
    const common = {
      entityId: entity.entity_id,
      name: stateObj.attributes.friendly_name || entity.name || entity.original_name || entity.entity_id,
    };

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
    :host { display:block; --at-accent:var(--primary-color,#03a9f4); --at-area:#7e57c2; --at-line:color-mix(in srgb,var(--at-accent) 35%,transparent); }
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
    .topology-scroll { flex:1 1 auto; min-width:0; height:var(--map-height); overflow:auto; overscroll-behavior:contain; background:radial-gradient(circle at center,color-mix(in srgb,var(--at-accent) 8%,transparent),transparent 47%); scrollbar-color:color-mix(in srgb,var(--at-accent) 45%,transparent) transparent; }
    .topology-canvas { position:relative; flex:none; }
    .topology { position:relative; min-width:1200px; min-height:1000px; overflow:hidden; transform:scale(var(--zoom)); transform-origin:0 0; }
    .web { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
    .web line { vector-effect:non-scaling-stroke; stroke-linecap:round; }
    .area-line { stroke:var(--at-accent); stroke-width:3; opacity:.5; }
    .device-line { stroke:color-mix(in srgb,var(--at-accent) 35%,transparent); stroke-width:1.5; stroke-dasharray:5 5; }
    .node { position:absolute; left:var(--x); top:var(--y); transform:translate(-50%,-50%); z-index:1; }
    .home { width:156px; height:104px; display:flex; flex-direction:column; align-items:center; justify-content:center; border:2px solid var(--at-accent); border-radius:50%; color:var(--primary-text-color,#222); background:var(--card-background-color,#fff); box-shadow:0 0 0 8px color-mix(in srgb,var(--at-accent) 9%,transparent),0 8px 28px rgba(0,0,0,.16); z-index:3; }
    .home>span { display:grid; place-items:center; width:38px; height:38px; margin-top:-3px; border-radius:50%; color:white; background:var(--at-accent); }
    .home-icon svg { width:24px; height:24px; fill:currentColor; }
    .home strong { margin-top:5px; font-size:16px; }
    .home small { margin-top:1px; font-size:9px; }
    .area { width:180px; min-height:72px; display:flex; align-items:center; padding:5px; border:2px solid var(--at-area); border-radius:999px; color:var(--primary-text-color,#222); background:color-mix(in srgb,var(--at-area) 8%,var(--card-background-color,#fff)); box-shadow:0 5px 16px rgba(0,0,0,.12); z-index:2; font:inherit; text-align:left; }
    .area:hover { box-shadow:0 0 0 5px color-mix(in srgb,var(--at-area) 12%,transparent),0 5px 16px rgba(0,0,0,.14); }
    .area.collapsed { background:color-mix(in srgb,var(--at-area) 16%,var(--card-background-color,#fff)); }
    .area.drop-target { transform:translate(-50%,-50%) scale(1.08); background:color-mix(in srgb,var(--success-color,#43a047) 22%,var(--card-background-color,#fff)); border-color:var(--success-color,#43a047); box-shadow:0 0 0 8px color-mix(in srgb,var(--success-color,#43a047) 18%,transparent),0 7px 20px rgba(0,0,0,.18); }
    .area-main { min-width:0; flex:1; display:flex; align-items:flex-start; gap:9px; padding:5px; border:0; color:inherit; background:none; font:inherit; text-align:left; cursor:pointer; }
    .area .toggle { display:grid; place-items:center; flex:0 0 24px; width:24px; height:24px; margin-right:4px; padding:0; border:0; border-radius:50%; color:white; background:var(--at-area); font:inherit; font-size:17px; line-height:1; cursor:pointer; }
    .area-icon,.device-icon { display:grid; place-items:center; flex:0 0 auto; border-radius:50%; }
    .area-icon { color:var(--at-area); background:color-mix(in srgb,var(--at-area) 16%,var(--card-background-color,#fff)); }
    .area-icon { width:40px; height:40px; margin-top:1px; }
    h2,h3 { margin:0; font-weight:600; }
    h2 { font-size:16px; } h3 { font-size:14px; overflow-wrap:anywhere; }
    small { display:block; margin-top:3px; color:var(--secondary-text-color,#727272); line-height:1.25; }
    .device { width:170px; padding:10px; border:1px solid color-mix(in srgb,var(--device-color) 50%,var(--divider-color,#ddd)); border-radius:12px; color:var(--primary-text-color,#222); background:color-mix(in srgb,var(--device-color) 6%,var(--card-background-color,#fff)); box-shadow:0 3px 11px rgba(0,0,0,.1); cursor:pointer; }
    .device:hover { box-shadow:0 0 0 4px color-mix(in srgb,var(--device-color) 10%,transparent),0 4px 13px rgba(0,0,0,.14); }
    .device-main { display:flex; align-items:flex-start; gap:10px; }
    .device-icon { width:34px; height:34px; margin-top:1px; color:var(--device-color); background:color-mix(in srgb,var(--device-color) 16%,var(--card-background-color,#fff)); } .device-icon ha-icon { --mdc-icon-size:20px; }
    .device-copy { min-width:0; }
    .statuses { display:flex; flex-wrap:wrap; gap:4px; margin:8px 0 0 44px; }
    .status { display:inline-flex; align-items:center; gap:3px; min-height:22px; padding:2px 6px; border:0; border-radius:7px; color:var(--secondary-text-color,#727272); background:var(--secondary-background-color,#eee); font:inherit; font-size:10px; cursor:pointer; }
    .status.active { color:var(--state-active-color,var(--warning-color,#f9a825)); background:color-mix(in srgb,var(--state-active-color,var(--warning-color,#f9a825)) 15%,var(--card-background-color,#fff)); }
    .status ha-icon { width:13px; height:13px; --mdc-icon-size:13px; }
    .labels { display:flex; flex-wrap:wrap; gap:4px; margin:7px 0 0 44px; }
    .labels span { display:inline-flex; align-items:center; gap:3px; padding:3px 8px; border-radius:999px; color:var(--label-contrast,#fff); background:var(--label-color); font-size:10px; font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.2); }
    .entities { margin:9px 0 0 44px; border-top:1px solid var(--divider-color,#ddd); padding-top:5px; }
    .entities button { width:100%; border:0; background:none; color:var(--primary-text-color,#222); display:flex; justify-content:space-between; gap:8px; padding:5px 0; cursor:pointer; text-align:left; font:inherit; font-size:11px; }
    .entities b { color:var(--secondary-text-color,#727272); font-weight:400; white-space:nowrap; }
    .unassigned-panel { flex:0 0 285px; width:285px; height:var(--map-height); overflow:hidden; display:flex; flex-direction:column; border-left:1px solid var(--divider-color,#ddd); background:var(--card-background-color,#fff); }
    .panel-head { display:flex; justify-content:space-between; align-items:center; padding:16px 16px 10px; }
    .panel-head h2 { font-size:16px; } .panel-head>ha-icon { color:var(--secondary-text-color,#727272); }
    .panel-help { margin:0 16px 12px; color:var(--secondary-text-color,#727272); font-size:11px; line-height:1.35; }
    .assignment-message { margin:0 12px 10px; padding:8px 10px; border-radius:8px; color:var(--primary-text-color,#222); background:var(--secondary-background-color,#eee); font-size:11px; }
    .assignment-message.success { color:var(--success-color,#43a047); } .assignment-message.error { color:var(--error-color,#db4437); }
    .unassigned-list { flex:1; min-height:0; overflow:auto; padding:0 10px 14px; }
    .unassigned-device { display:flex; align-items:flex-start; gap:8px; margin-bottom:8px; padding:9px 8px; border:1px solid color-mix(in srgb,var(--device-color) 42%,var(--divider-color,#ddd)); border-radius:10px; background:color-mix(in srgb,var(--device-color) 6%,var(--card-background-color,#fff)); cursor:grab; box-shadow:0 2px 6px rgba(0,0,0,.08); }
    .unassigned-device:active { cursor:grabbing; } .unassigned-device.dragging { opacity:.42; }
    .drag-handle { align-self:center; color:var(--secondary-text-color,#727272); font-weight:700; letter-spacing:-3px; }
    .unassigned-device .device-icon { flex:0 0 32px; width:32px; height:32px; }
    .unassigned-device>button { min-width:0; flex:1; padding:0; border:0; color:var(--primary-text-color,#222); background:none; text-align:left; font:inherit; cursor:pointer; }
    .unassigned-device strong { display:block; overflow-wrap:anywhere; font-size:12px; }
    .unassigned-device small { font-size:10px; }
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
