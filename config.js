const CONFIG = {
    // SwissTopo STAC API.
    //
    // v0.9 is deprecated, so use v1.
    STAC_ROOT:
        "https://data.geo.admin.ch/api/stac/v1",

    COLLECTION:
        "ch.swisstopo.swisssurface3d",

    // Maximum number of tiles shown on the map.
    MAX_TILES:
        200,

    // Maximum number of COPC clouds simultaneously loaded.
    MAX_LOADED_POINTCLOUDS:
        4,

    // Potree point budget.
    POINT_BUDGET:
        2_000_000,

    // Swiss national coordinate system.
    EPSG:
        2056,

    // Map center: Switzerland.
    MAP_CENTER:
        [46.8182, 8.2275],

    MAP_ZOOM:
        8,

    // SwissTopo map tiles.
    BASEMAP:
        "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",

    BASEMAP_ATTRIBUTION:
        "© swisstopo",

    // GeoAdmin search API.
    SEARCH_URL:
        "https://api3.geo.admin.ch/rest/services/ech/SearchServer"
};
