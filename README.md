# Area Topology Card

A dependency-free Home Assistant dashboard card that groups devices by area and presents them as a network-style topology. A device uses the icon from its first assigned label that has an icon.

## Features

- Radial Home → Area → Device topology
- Collision-aware multi-ring layout for larger installations
- Expand/collapse individual areas or the entire map
- Filters for labelled and unassigned devices
- Individual label toggles, with all labels selected initially
- Label icons and colours
- Direct links to Home Assistant area and device settings
- Full-height, two-direction scrolling canvas

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
show_entities: false
show_only_labeled: true
map_height: auto
```

Refresh the browser after updating the JavaScript. A query-string version is optional; a hard refresh reloads the stable `/local/area-topology-card.js` URL during development.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `title` | `Home topology` | Card heading |
| `show_unassigned` | `false` | Include devices that are not assigned to an area initially |
| `show_entities` | `false` | List each device's entities and current states |
| `show_only_labeled` | `true` | Initially show only devices with at least one label |
| `map_height` | `auto` | Fill the available screen height, or set a pixel value |

The card reads Home Assistant's area, device, entity, and label registries through the authenticated frontend connection. No separate backend integration, token, or external service is required.

Area nodes can be selected to expand or collapse their devices. Header controls expand or collapse all areas and toggle the Unassigned branch. The canvas grows into additional device rings as needed and scrolls in both directions.

Clicking an area name opens its Home Assistant area settings. Use the small `+`/`−` button to expand or collapse it. Clicking a device opens that device's configuration page.

## Quick local updates

If your Home Assistant config folder is mounted or shared on this computer, run:

```sh
sh sync-to-home-assistant.sh /path/to/home-assistant/config
```

The script updates `www/area-topology-card.js`. Keep the dashboard resource URL as `/local/area-topology-card.js`; it does not need to change for each release. Hard-refresh Home Assistant after syncing.

## Updates

When a new version is available, update the card from HACS and refresh Home Assistant. Development installations can continue using the local sync script above.
