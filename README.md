# Area Topology Card

A dependency-free Home Assistant dashboard card that groups devices by area and presents them as a network-style topology. A device uses the icon from its first assigned label that has an icon.

## Features

- Radial Home → Area → Device topology, with an automatic Floor level when multiple floors exist
- Switchable spider-web, hierarchical tree, and LCARS dashboard layouts
- Collision-aware multi-ring layout for larger installations
- Expand/collapse floors, areas, or the entire map with space-aware reflow
- Filters for labelled and unassigned devices
- Drag-and-drop device cards and unassigned devices for assigning them to areas
- Individual label toggles, with all labels selected initially
- Label icons and colours
- Live device status for batteries, lights, plugs, doors, windows, locks, covers, temperature, illuminance, humidity and climate
- Direct links to Home Assistant area and device settings
- Full-height, two-direction scrolling canvas
- Header zoom controls
- Hovered device cards rise above neighbouring nodes
- Persistent Unassigned and Labelled-only display preferences

## Install with HACS

1. In HACS, open the three-dot menu and choose **Custom repositories**.
2. Add `https://github.com/plai-os/Area-Topology` and select **Dashboard** as the category.
3. Find **Area Topology Card** in HACS and select **Download**.
4. Refresh Home Assistant.
5. Add a Manual card using the configuration below.

## Try the layout locally

From this folder, start any static web server, for example:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/demo.html`. The demo uses sample data and does not connect to Home Assistant.

## Install locally in Home Assistant

1. Copy `area-topology-card.js` into `<your Home Assistant config>/www/area-topology-card.js`.
2. Restart Home Assistant if this is the first time you have created the `www` folder.
3. Go to **Settings → Dashboards**, open the three-dot menu, choose **Resources**, and add:
   - URL: `/local/area-topology-card.js`
   - Resource type: **JavaScript module**
4. Add a manual card to a dashboard:

```yaml
type: custom:area-topology-card
title: My home
show_unassigned: false
show_only_labeled: true
initial_label_selection: all
layout: web
web_zoom: 1
tree_font_scale: 1
web_show_properties: false
tree_show_properties: true
floors_expanded: true
areas_expanded: true
tree_devices_expanded: false
show_status: true
hide_child_lock: true
max_statuses: 3
map_height: auto
```

Refresh the browser after updating the JavaScript. A query-string version is optional; a hard refresh reloads the stable `/local/area-topology-card.js` URL during development.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `title` | `Home topology` | Card heading |
| `show_unassigned` | `false` | Include devices that are not assigned to an area initially |
| `show_only_labeled` | `true` | Initially show only devices that have labels |
| `initial_label_selection` | `all` | Initial label filters: `all` or `none`; saved user choices take precedence later |
| `layout` | `web` | Initial layout: `web`, `tree`, or `lcars`; the header switch remembers later changes |
| `web_zoom` | `1` | Initial Web-view zoom from `0.65` to `1.8` |
| `tree_font_scale` | `1` | Initial Tree-view font scale from `0.65` to `1.8` |
| `web_show_properties` | `false` | Show entity/property rows on Web device cards |
| `tree_show_properties` | `true` | Allow entity/property rows beneath Tree devices |
| `floors_expanded` | `true` | Initially expand floor nodes |
| `areas_expanded` | `true` | Initially expand area nodes |
| `tree_devices_expanded` | `false` | Initially expand Tree devices to show their properties |
| `show_status` | `true` | Show compact live-status chips on device nodes |
| `hide_child_lock` | `true` | Hide child-lock entities from LCARS, Web, and Tree properties |
| `max_statuses` | `3` | Maximum number of status chips shown per device |
| `map_height` | `auto` | Fill the available screen height, or set a pixel value |

`topology_zoom` and `show_entities` remain supported as legacy aliases for `web_zoom` and `web_show_properties`.

The card reads Home Assistant's floor, area, device, entity, and label registries through the authenticated frontend connection. No separate backend integration, token, or external service is required.

The LCARS view groups live systems by floor and area. It prioritises useful readings such as temperature, humidity, illumination, battery, door/lock state, light and plug state, climate state, and media-player volume. Select `LCARS` in the header or set `layout: lcars` in YAML to make it the initial view.

## Standalone LCARS dashboard card

The same JavaScript resource also provides `custom:lcars-home-card`. This independent card renders only the LCARS dashboard, without the Home Topology header, layout controls, label toolbar, or unassigned panel. It always shows labelled devices only and always excludes unassigned devices.

Omit `labels`, `floors`, or `areas` to include all entries of that type. When supplied, each option is a YAML list and accepts either the visible Home Assistant name or registry ID.
The order of each YAML list is also the display order: floors follow `floors`, area panels follow `areas`, and LCARS device groups follow `labels`.
Use `label_colors`, `floor_colors`, and `area_colors` to override colours by visible name or registry ID. Any item without an override retains its current Home Assistant or LCARS colour.
The standalone dashboard includes a numbered floor navigator on the left. Only one floor is displayed at a time: it starts on the first configured floor, and selecting another tab replaces the dashboard content with that floor. Its tab order and colours follow `floors` and `floor_colors`. On narrow screens it becomes a horizontal navigation strip. Floor and room headings use the same condensed LCARS-style display type.

```yaml
type: custom:lcars-home-card
title: Sarn
labels:
  - Alexa
  - Lamps
  - Climate
floors:
  - Ground Floor
  - Loft Floor
areas:
  - Lounge
  - Kitchen
  - Bedroom
label_colors:
  Alexa: "#B8A46A"
  Lamps: "#C98F65"
floor_colors:
  Ground Floor: "#B987A9"
area_colors:
  Lounge: "#8F8FC4"
  Kitchen: "#A77F9F"
```

An explicitly empty list selects no entries, which is useful while building a dashboard configuration incrementally.

When Home Assistant has more than one floor, floor nodes are shown between Home and Area nodes. Floors and areas start expanded. Collapse all stops at floors when that level is available; otherwise it stops at areas. The canvas grows into additional device rings as needed and scrolls in both directions.

Clicking an area name opens its Home Assistant area settings. Use the small `+`/`−` button to expand or collapse it. Clicking a device opens that device's configuration page.

## Quick local updates

If your Home Assistant config folder is mounted or shared on this computer, run:

```sh
sh sync-to-home-assistant.sh /path/to/home-assistant/config
```

The script updates `www/area-topology-card.js`. Keep the dashboard resource URL as `/local/area-topology-card.js`; it does not need to change for each release. Hard-refresh Home Assistant after syncing.

## Updates

When a new version is available, update the card from HACS and refresh Home Assistant. Development installations can continue using the local sync script above.
