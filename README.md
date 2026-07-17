# Area Topology Card

A dependency-free Home Assistant dashboard card that groups devices by area and presents them as a network-style topology. A device uses the icon from its first assigned label that has an icon.

## Features

- Radial Home → Area → Device topology, with an automatic Floor level when multiple floors exist
- Switchable spider-web and hierarchical tree layouts
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

## Standalone LCARS dashboard card

The same JavaScript resource also provides `custom:lcars-home-card`. This independent card groups live systems by floor and area and prioritises useful readings such as temperature, humidity, illumination, battery, door/lock state, light and plug state, climate state, and media-player volume. It renders without the Home Topology header, layout controls, label toolbar, or unassigned panel. It always shows labelled devices only and always excludes unassigned devices.

Omit `labels`, `floors`, or `areas` to include all entries of that type. When supplied, each option is a YAML list and accepts either the visible Home Assistant name or registry ID.
The order of each YAML list is also the display order: floors follow `floors`, area panels follow `areas`, and LCARS device groups follow `labels`.
Use `label_colors`, `floor_colors`, and `area_colors` to override colours by visible name or registry ID. Any item without an override retains its current Home Assistant or LCARS colour.
The standalone dashboard includes a numbered floor navigator on the left. Only one floor is displayed at a time: it starts on the first configured floor, and selecting another tab replaces the dashboard content with that floor. Its tab order and colours follow `floors` and `floor_colors`. On narrow screens it becomes a horizontal navigation strip. Floor and room headings use the same condensed LCARS-style display type.
Selecting a non-toggle reading opens an LCARS-themed entity overlay with its current value and 24-hour Home Assistant history graph.

```yaml
type: custom:lcars-home-card
title: Sarn
header_color: "#263F4B"
datetime_color: "#FF9900"
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
weather:
  entity: weather.pirateweather
  sun_entity: sun.sun
  temperature_sensor: sensor.outdoor_temp
  humidity_sensor: sensor.outdoor_humidity
  apparent_sensor: sensor.real_feel_temperature
  aqi_sensor: sensor.air_quality_index
  wind_speed_sensor: sensor.outdoor_wind_speed
  wind_gust_sensor: sensor.outdoor_wind_gust
  hourly_rain_sensor: sensor.hourly_rain
  dew_point_sensor: sensor.outdoor_dew_point
  uv_index_sensor: sensor.uv_index
  pressure_sensor: sensor.outdoor_pressure
  forecast_rows: 10
  hourly_rows: 8
  locale: en-GB
  hourly_forecast: false
  show_decimal: true
  color: "#66AACC"
security:
  color: "#B56B7A"
  cameras:
    - entity: camera.c110_mainstream
      camera_image: camera.c110_mainstream
      name: Car
      show_state: true
      camera_view: auto
      fit_mode: cover
engineering:
  color: "#FF9966"
  chart_color: "#FF9966"
  chart_secondary_color: "#9999FF"
  chart_tertiary_color: "#FFCC99"
  metrics:
    - name: Demand
      icon: mdi:flash
      entity: sensor.octopus_energy_electricity_22p5024798_2200042031306_current_demand
    - name: Standing
      icon: mdi:currency-gbp
      entity: sensor.octopus_energy_electricity_22p5024798_2200042031306_current_standing_charge
    - name: Rate
      icon: mdi:currency-gbp
      entity: sensor.octopus_energy_electricity_22p5024798_2200042031306_current_rate
    - name: Points
      icon: mdi:trophy-outline
      entity: sensor.octopus_energy_a_52705f81_octoplus_points
  panels:
    - title: Energy Consumption
      icon: mdi:lightning-bolt
      type: statistics-graph
      grid_options:
        columns: 12
        rows: auto
      entities:
        - sensor.octopus_energy_electricity_22p5024798_2200042031306_current_demand
      days_to_show: 7
      period: day
      chart_type: bar
      stat_types:
        - max
      hide_legend: true
    - title: Live Demand
      icon: mdi:chart-line
      type: statistics-graph
      grid_options:
        columns: 12
        rows: auto
      entities:
        - sensor.octopus_energy_electricity_22p5024798_2200042031306_current_demand
      days_to_show: 1
      period: hour
      chart_type: line
      stat_types:
        - mean
      hide_legend: true
      logarithmic_scale: false
    - title: Solar Available
      icon: mdi:solar-power
      type: sensor
      entity: sensor.sarn_32_maesderw_sarn
      graph: line
      detail: 2
      name: Solar Available (Sarn)
      theme: Frosted Glass Dark Lite
      hours_to_show: 48
```

Adding `weather.entity` creates a numbered `WEATHER` destination in the standalone LCARS navigation. The optional sensor entries override the matching values supplied by the weather entity. Daily and hourly forecasts are requested directly from Home Assistant and displayed in separate LCARS panels.
Adding one or more `security.cameras` creates a numbered `SECURITY` destination. Each camera is rendered as a Home Assistant picture-entity feed inside an LCARS area-style panel. Set `show_state: false` to omit its state from the panel header.
Adding one or more `engineering.panels` creates a numbered `ENGINEERING` destination. Each entry accepts a standard Home Assistant Lovelace card configuration plus an LCARS `title` and `icon`, and is rendered inside a matching area-style panel. The three `chart_*_color` settings control the embedded graph series palette.

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
