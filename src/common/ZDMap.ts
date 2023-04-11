import * as ZDCRS from "./ZDCRS";
import { Control, DomEvent, DomUtil, LatLngBounds, Map, Point } from "leaflet";
import { dom, library } from "@fortawesome/fontawesome-svg-core";
import { Category } from "./Category";
import { ZDControl } from "./ZDControl";
import { Dialog } from "./Dialog";
import { Legend } from "./Legend";
import { LocalStorage } from "./LocalStorage";
import { ZDMarker } from "./ZDMarker";
import { MapLayer } from "./MapLayer";
import { WikiConnector } from "./WikiConnector";
import { faCog } from "@fortawesome/free-solid-svg-icons/faCog";
import { faSearch } from "@fortawesome/free-solid-svg-icons/faSearch";
import { params } from "./QueryParameters";

library.add(faSearch, faCog);
dom.watch();

/**
 * Base class for all Zelda maps
 */
export class ZDMap extends Map {
  // BUGBUG refactor to avoid having to suppress null checking
  public wiki!: WikiConnector;
  private settingsStore!: LocalStorage;
  private legend!: Legend;
  private legendLandscape!: Legend;
  private layers = <MapLayer[]>[];
  private loginFn!: (username: string) => void;

  private constructor(
    element: string | HTMLElement,
    private tileSize: number,
    private bounds: LatLngBounds,
    options?: L.MapOptions
  ) {
    super(element, options);
  }

  public static create(
    directory: string,
    mapSize: number,
    tileSize: number,
    options: L.MapOptions = {}
  ): ZDMap {
    const maxZoom = Math.round(Math.log(mapSize / tileSize) * Math.LOG2E);
    options.maxZoom = maxZoom;
    if (options.zoom == undefined) {
      options.zoom = maxZoom - 2;
    }

    let initLat = Number(params.x);
    if (isNaN(initLat)) {
      initLat = Number(params.lat);
    }
    let initLng = Number(params.y);
    if (isNaN(initLng)) {
      initLng = Number(params.lng);
    }
    if (!isNaN(initLat) && !isNaN(initLng)) {
      options.center = [initLat, initLng];
    }

    const crs = ZDCRS.create(mapSize, tileSize);
    options.crs = crs;

    const bounds = new LatLngBounds(
      crs.pointToLatLng(new Point(0, mapSize), maxZoom),
      crs.pointToLatLng(new Point(mapSize, 0), maxZoom)
    );
    options.maxBounds = bounds.pad(0.5);

    options.zoomControl = false; // adding it later, below our own controls
    options.attributionControl = false; // would like to keep this but breaks bottom legend. maybe find a better place to put it later

    const map = new ZDMap("map", tileSize, bounds, options);
    map.getContainer().classList.add(`zd-map-${directory}`);

    map.settingsStore = LocalStorage.getStore(directory, "settings");
    map.wiki = new WikiConnector(directory, new Dialog(map));

    map.legend = Legend.createPortrait().addTo(map);
    map.legendLandscape = Legend.createLandscape().addTo(map);

    map.on("click", (e) => {
      console.log(e.latlng);
      map.panTo(e.latlng);
    });

    return map;
  }

  public addMapLayer(directory: string, layerName = "Default"): void {
    const layer = new MapLayer(
      layerName,
      directory,
      this.tileSize,
      this.getMaxZoom(),
      this.bounds
    );
    this.layers.push(layer);
    this.addLayer(layer.tileLayer);
    this.addLayer(layer.markerLayer);
  }

  public addControls(tags: string[] = []): void {
    tags.push("Completed");
    const searchControl = this.initializeSearchControl();
    const settingsControl = this.initializeSettingsControl(tags);

    // TODO custom layers control that takes MapLayer instead of TileLayer
    if (this.layers.length > 1) {
      const layersObject: Control.LayersObject = {};
      for (const layer of this.layers) {
        layersObject[layer.layerName] = layer.tileLayer;
      }
      new Control.Layers(layersObject, undefined, {
        position: "topleft",
      }).addTo(this);
    }

    new Control.Zoom({
      position: "topleft",
    }).addTo(this);

    // When one control opens, close the others
    searchControl.onOpen(() => {
      settingsControl.close();
    });
    settingsControl.onOpen(() => {
      searchControl.close();
    });
  }

  public async initializeWikiConnector(): Promise<void> {
    await this.wiki.getLoggedInUser();

    if (this.loginFn && this.wiki.user) {
      this.loginFn(this.wiki.user.name);
    }

    // load marker completion from wiki into marker layers
    const completedMarkers = await this.wiki.getCompletedMarkers();
    for (let i = 0; i < completedMarkers.length; ++i) {
      for (const layer of this.layers) {
        const marker = layer.getMarkerById(completedMarkers[i]);
        if (marker) {
          marker.complete();
          break;
        }
      }
    }
  }

  public addCategory(category: Category): void {
    category.addToMap(this);
    if (category.displayOrder != undefined) {
      this.legend.addCategory(category, category.displayOrder);
      this.legendLandscape.addCategory(category, category.displayOrder);
    }
  }

  // TODO move this whole function to MapLayer
  public addMarker(marker: ZDMarker): void {
    marker.addToMap(this); // TODO get rid of this call
    this.layers[0]?.addMarker(
      // TODO add to correct layer
      marker,
      this.project(marker.getLatLng(), 0)
    );
    if (params.id === marker.id) {
      this.focusOn(marker);
    }
  }

  public navigateToMarkerById(id: string): void {
    // TODO get (or set?) active layer
    for (const layer of this.layers) {
      const marker = layer.getMarkerById(id);
      if (marker) {
        this.focusOn(marker);
        break;
      }
    }
  }

  private initializeSearchControl(): ZDControl {
    const searchContent = DomUtil.create("div", "zd-search");
    const searchBox = <HTMLInputElement>(
      DomUtil.create("input", "zd-search__searchbox", searchContent)
    );
    searchBox.setAttribute("type", "text");
    searchBox.setAttribute("placeholder", "Search");
    const results = DomUtil.create("ul", "zd-search__results", searchContent);

    const searchControl = ZDControl.create({
      icon: "search",
      content: searchContent,
    }).addTo(this);

    let searchVal = "";
    DomEvent.addListener(searchBox, "input", (e) => {
      DomUtil.empty(results);
      const searchStr = searchBox.value;
      // length > 2 and either value changed or on focus
      if (
        searchStr &&
        searchStr.length > 2 &&
        (searchVal !== searchStr || e.type === "focus")
      ) {
        // regex (escape regex chars)
        const searchRegex = new RegExp(
          searchStr.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&"),
          "i"
        );
        this.layers.forEach((layer) => {
          layer.findMarkers(searchRegex).forEach((m: ZDMarker) => {
            const result = DomUtil.create("li", "zd-search__result", results);
            result.innerText = m.name;
            result.style.backgroundImage = `url(${m.getIconUrl()})`;
            result.style.backgroundPosition = `${
              (50 - m.getIconWidth()) / 2
            }px center`;
            DomEvent.addListener(result, "click", () => {
              searchControl.close();
              this.focusOn(m);
            });
          });
        });
      }
      // save current value
      searchVal = searchStr || "";
    });

    searchControl.onOpen(() => {
      searchBox.focus();
    });

    searchControl.onClosed(() => {
      searchBox.blur();
    });

    return searchControl;
  }

  private initializeSettingsControl(tags: string[]): ZDControl {
    const settingsContent = DomUtil.create("table", "zd-settings");
    const userRow = DomUtil.create(
      "tr",
      "zd-settings__setting",
      settingsContent
    );
    const userCell = DomUtil.create("td", "", userRow);
    userCell.setAttribute("colspan", "3");
    const loginButton = DomUtil.create("div", "selectable", userCell);
    loginButton.innerText = "Login";
    DomEvent.addListener(loginButton, "click", () => {
      this.wiki.login();
    });

    this.loginFn = (username: string) => {
      DomUtil.empty(userCell);
      const logoutButton = DomUtil.create("div", "selectable", userCell);
      logoutButton.style.cssFloat = "right";
      logoutButton.innerText = "Logout";
      DomEvent.addListener(logoutButton, "click", () => {
        this.wiki.logout();
      });
      const usernameLabel = DomUtil.create("div", "", userCell);
      usernameLabel.innerText = username;
    };

    tags.forEach((tag) => {
      const row = DomUtil.create("tr", "zd-settings__setting", settingsContent);
      const show = DomUtil.create("td", "zd-settings__button selectable", row);
      show.innerText = "Show";
      const hide = DomUtil.create("td", "zd-settings__button selectable", row);
      hide.innerText = "Hide";
      const label = DomUtil.create("th", "zd-settings__label", row);
      label.innerText = tag;

      const settingValue = this.settingsStore.getItem<boolean>(`show-${tag}`);
      if (
        settingValue === false ||
        (tag === "Completed" && settingValue !== true) // Completed is hidden by default
      ) {
        DomUtil.addClass(hide, "selected");
      } else {
        this.layers.forEach((l) => l.showTaggedMarkers(tag));
        DomUtil.addClass(show, "selected");
      }

      DomEvent.addListener(show, "click", () => {
        if (!DomUtil.hasClass(show, "selected")) {
          DomUtil.removeClass(hide, "selected");
          DomUtil.addClass(show, "selected");
          this.layers.forEach((l) => l.showTaggedMarkers(tag));
          this.settingsStore.setItem(`show-${tag}`, true);
        }
      });
      DomEvent.addListener(hide, "click", () => {
        if (!DomUtil.hasClass(hide, "selected")) {
          DomUtil.removeClass(show, "selected");
          DomUtil.addClass(hide, "selected");
          this.layers.forEach((l) => l.hideTaggedMarkers(tag));
          this.settingsStore.setItem(`show-${tag}`, false);
        }
      });
    });
    const clearCompletionDataRow = DomUtil.create(
      "tr",
      "zd-settings__setting",
      settingsContent
    );
    const clearCompletionData = DomUtil.create(
      "td",
      "selectable",
      clearCompletionDataRow
    );
    clearCompletionData.setAttribute("colspan", "3");
    clearCompletionData.innerText = "Clear completion data";
    DomEvent.addListener(clearCompletionData, "click", () => {
      if (
        confirm(
          "This will reset all pins that you've marked completed. Are you sure?"
        )
      ) {
        this.wiki.clearCompletion();
        this.layers.forEach((l) => l.clearTaggedMarkers("Completed"));
      }
    });

    return ZDControl.create({
      icon: "cog",
      content: settingsContent,
    }).addTo(this);
  }

  private focusOn(marker: ZDMarker): void {
    this.legend.reset();
    this.legendLandscape.reset();
    this.setView(
      marker.getLatLng(),
      Math.max(marker.getMinZoom(), this.getZoom())
    );
    marker.openPopupWhenLoaded();
  }
}
