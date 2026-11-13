
/**
 * MAPBIOMAS BRAZIL 1985-2025 | V3 | TWO PRODUCTION BATCHES
 *
 * ONLY TWO WORKFLOWS:
 *   BATCH='ANNUAL'  -> all annual LULC + annual theme staging, then annual assets.
 *   BATCH='MONTHLY' -> all monthly fire/water staging, then monthly assets.
 *
 * ACTION='PLAN' inspects existing assets and previews up to 40 next tasks.
 * ACTION='CREATE' generates drafts for an entire phase at once (up to 500).
 * ANNUAL phase 1: 80 staged exports (2 per year); phase 2: 40 annual finals.
 * MONTHLY phase 1: 480 stage exports (1 per month); phase 2: 480 finals.
 * The next phase needs the previous phase's SAVED assets to be completed.
 * Start generated draft tasks in the Code Editor Tasks tab.
 * Rerun after tasks COMPLETE: the script automatically advances from
 * intermediate (0.1/12 degree) to FINAL native 0.1-degree assets.
 *
 * Why staging: previous one-pass Brazil exports exceeded EE's 2^31 source
 * pixels limit. Staging materializes the first 30m aggregation as assets.
 *
 * FINAL annual: 17 signed Int16 bands; FINAL monthly: 15 bands.
 * Stored thematic integer = round(actual_percentage * 100), 0..10000.
 * Five fire-group bands = % of THAT LULC group's area burned.
 * Seven LULC groups; fire intersections exclude Mosaic and Urban.
 * Water is total water only. Climate/heatwaves joined virtually for stats.
 *
 * IMPORTANT: draft task creation and running tasks are different things.
 * Older script incorrectly suppressed draft creation when 40 unrelated tasks
 * were already active. ENFORCE_ACTIVE_CAP=false now fixes that.
 * GEE still decides actual server-side batch concurrency.
 *
 * 2025 logging fix (2026-11-13): logging_2025 is not requested.
 * Retain two masked bands for 2025 and preserve 17-band output schema.
 *
 * V4 PROJECTION FIX (2026-11-09): All multiband 30m indicator stacks
 * receive the 30m LULC native DEFAULT projection BEFORE reduceResolution.
 * This prevents 'input does not have a valid default projection', including
 * 1985-1987 when the logging bands are fully masked.
 * No forced .reproject() of nationwide 30m input is performed.
 */

// ==========================================================================
// 1. EDIT ONLY THIS SECTION FOR NORMAL USE
// ==========================================================================

var BATCH = 'ANNUAL';            // 'ANNUAL' or 'MONTHLY'
var ACTION = 'CREATE';           // 'PLAN', 'CREATE', 'AUDIT', 'VIRTUAL_QA'

var YEAR_START = 2025;
var YEAR_END = 2025;

var MONTH_START = 1;             // Used for MONTHLY batch
var MONTH_END = 12;

var MAX_NEW_TASKS_PER_RUN = 500;     // All 80 annual staging or 480 monthly staging drafts
var MAX_ACTIVE_TASKS = 40;         // Advisory only when ENFORCE_ACTIVE_CAP=true

var ENFORCE_ACTIVE_CAP = false;  // Do not suppress draft creation
var REQUIRE_ALL_ANNUALS = true;  // Monthly starts after all selected annual assets
var MONTH_PACK_SIZE = 1;         // 1=validated shape; 3 experimental

var INCLUDE_LOGGING = true;
var DETECT_2024_LEGACY_STAGING = true;
var CHECK_RUNNING_TASKS = true;

var DEST_FOLDER = 'projects/mapbiomas-brazil/assets/DEGRADATION/' +
  'COLLECTION-11/atmosphere/test';

// --------------------------------------------------------------------------
// ADVANCED: spatial grid, QA and optional virtual climate integration
// --------------------------------------------------------------------------

var MID_DIVISIONS = 12;
var STAGE_MAX_PIXELS = 4096;
var FINAL_MAX_PIXELS = 256;

var STAGE_SHARD_SIZE = 16;
var FINAL_SHARD_SIZE = 32;

var PERCENT_STORAGE_SCALE = 100;

var QA_YEAR = 2024;
var QA_MONTH = 9;

var SHOW_VIRTUAL_MAP = false;
var INCLUDE_HEATWAVES_IN_VIRTUAL = true;
var HEATWAVE_VERSION = 'V2';
var HEATWAVE_SPEC_VERSION = 1;

// Seven annual LULC groups. Overlaps are intentional.

var LULC_GROUPS = [
  {name: 'Forest', classes: [3,5,6,49]},
  {name: 'Savannas, Grasslands and Wetlands',
    classes: [4,7,12,77,11,84,50,32,29]},
  {name: 'Pasture', classes: [15]},
  {name: 'Agriculture', classes: [19,39,20,40,62,41,36,46,47,35,48]},
  {name: 'Mosaic of uses', classes: [21]},
  {name: 'Farming', classes: [15,19,39,20,40,62,41,36,46,47,35,48,9]},
  {name: 'Urban', classes: [24]}
];

var FIRE_GROUP_EXCLUSIONS = ['Mosaic of uses', 'Urban'];

// ==========================================================================
// 2. CONFIGURATION VALIDATION, SOURCES AND REFERENCE GRID
// ==========================================================================

if (['ANNUAL','MONTHLY'].indexOf(BATCH) < 0)
  throw new Error('BATCH must be ANNUAL or MONTHLY');

if (['PLAN','CREATE','AUDIT','VIRTUAL_QA'].indexOf(ACTION) < 0)
  throw new Error('ACTION must be PLAN, CREATE, AUDIT, or VIRTUAL_QA');

if (YEAR_START < 1985 || YEAR_END > 2025 || YEAR_END < YEAR_START)
  throw new Error('YEAR_START..YEAR_END must be within 1985..2025');

if (MONTH_START < 1 || MONTH_END > 12 || MONTH_START > MONTH_END)
  throw new Error('MONTH_START / MONTH_END must be 1..12');

if ([1,2,3,4].indexOf(MONTH_PACK_SIZE) < 0 ||
    PERCENT_STORAGE_SCALE !== 100 ||
    MAX_NEW_TASKS_PER_RUN < 1 || MAX_NEW_TASKS_PER_RUN > 1000 ||
    Math.floor(MAX_NEW_TASKS_PER_RUN) !== MAX_NEW_TASKS_PER_RUN ||
    MAX_ACTIVE_TASKS < 1)
  throw new Error('Use month pack 1..4, scale 100, task cap 1..1000, active cap >0');

function pad2(n) {
  return ('0' + n).slice(-2);
}

function slug(s) {
  return String(s).toLowerCase()
    .replace(/[áàâãä]/g,'a')
    .replace(/[éèêë]/g,'e')
    .replace(/[íìîï]/g,'i')
    .replace(/[óòôõö]/g,'o')
    .replace(/[úùûü]/g,'u')
    .replace(/ç/g,'c')
    .replace(/[^a-z0-9]+/g,'_')
    .replace(/^_+|_+$/g,'');
}

var groupSeen = {};

LULC_GROUPS.forEach(function(g) {
  g.key = slug(g.name);

  if (groupSeen[g.key] || !g.key || !g.classes.length) {
    throw new Error('Duplicate or invalid group: ' + g.name);
  }

  groupSeen[g.key] = true;
});

var excludedKeys = FIRE_GROUP_EXCLUSIONS.map(slug);

var FIRE_GROUPS = LULC_GROUPS.filter(function(g) {
  return excludedKeys.indexOf(g.key) < 0;
});

if (LULC_GROUPS.length !== 7 || FIRE_GROUPS.length !== 5) {
  throw new Error('Expected 7 annual groups and 5 fire-intersection groups.');
}

var LULC_STAGE_NAMES = ['lulc_valid'].concat(
  LULC_GROUPS.map(function(g) {
    return 'grp_' + g.key;
  })
);

var ANNUAL_THEME_NAMES = ['fire_annual','water_annual'].concat(
  FIRE_GROUPS.map(function(g) {
    return 'fire_in_grp_' + g.key;
  })
);

var MONTHLY_THEME_NAMES = ['fire_month','water_month'].concat(
  FIRE_GROUPS.map(function(g) {
    return 'fire_in_grp_' + g.key;
  })
);

var LOGGING_STAGE_NAMES = ['logging_annual','logging_source_mask'];

var LULC_OUT_NAMES = ['lulc_valid_pct'].concat(
  LULC_GROUPS.map(function(g) {
    return 'grp_' + g.key + '_pct';
  })
);

// --------------------------------------------------------------------------
// Source assets
// --------------------------------------------------------------------------

var P = 'projects/mapbiomas-public/assets/brazil/';
var A = P + 'atmosphere/collection1/';
var F = P + 'fire/collection5_1/';
var W = P + 'water/collection5/';

var LOGGING_ID = 'projects/mapbiomas-brazil/assets/DEGRADATION/' +
  'COLLECTION-10/public/logging_v2';

var HW_FOLDER = 'projects/mapbiomas-brazil/assets/DEGRADATION/' +
  'COLLECTION-11/CLIMATIC_WAVES/' +
  (HEATWAVE_VERSION === 'V2' ? 'heatWaves_v2_agg' : 'heatWaves_agg');

var RAIN_ALL = ee.Image(A +
  'mapbiomas_brazil_collection1_precipitation_annual_v2');

var GRID = RAIN_ALL.select('precipitation_2024').projection();
var GRID_INFO = GRID.getInfo();
var T = GRID_INFO.transform;

if (!Array.isArray(T) || T.length !== 6 ||
    !T.every(function(x) {
      return typeof x === 'number' && isFinite(x);
    })) {
  throw new Error('Invalid native atmosphere affine transform.');
}

var MID_TRANSFORM = [
  T[0] / MID_DIVISIONS,
  T[1] / MID_DIVISIONS,
  T[2],
  T[3] / MID_DIVISIONS,
  T[4] / MID_DIVISIONS,
  T[5]
];

var BRAZIL_RECT = ee.Geometry.Rectangle(
  [-75,-35,-28,6], null, false
);

var BRAZIL = ee.FeatureCollection('FAO/GAUL/2015/level0')
  .filter(ee.Filter.eq('ADM0_NAME','Brazil'));

// --------------------------------------------------------------------------
// Asset naming
// --------------------------------------------------------------------------

function prefix(y) {
  return 'dh-thematic-atmosphere-data-integration-' + y + '-';
}

function annualId(y) {
  return DEST_FOLDER + '/' + prefix(y) + '00-annual';
}

function monthlyId(y,m) {
  return DEST_FOLDER + '/' + prefix(y) + pad2(m) + '-monthly';
}

function stageLulcId(y) {
  return DEST_FOLDER + '/' + prefix(y) + '00-intermediate-lulc';
}

function stageAnnualId(y) {
  return DEST_FOLDER + '/' + prefix(y) + '00-intermediate-annual';
}

function monthPack(m) {
  var start = Math.floor((m-1)/MONTH_PACK_SIZE) * MONTH_PACK_SIZE + 1;
  var end = Math.min(12, start + MONTH_PACK_SIZE - 1);
  var mm = [];

  for (var x = start; x <= end; x++) mm.push(x);

  return {start:start, end:end, months:mm};
}

function stageMonthId(y,m) {
  var pk = monthPack(m);

  if (MONTH_PACK_SIZE === 1) {
    return DEST_FOLDER + '/' + prefix(y) +
      pad2(m) + '-intermediate-monthly';
  }

  return DEST_FOLDER + '/' + prefix(y) +
    pad2(pk.start) + '_' + pad2(pk.end) +
    '-intermediate-monthly-pack' + MONTH_PACK_SIZE;
}

function monthStageBand(base,m) {
  return MONTH_PACK_SIZE === 1
    ? base
    : 'm' + pad2(m) + '_' + base;
}

// ==========================================================================
// 3. ASSET INVENTORY. SKIP COMPLETED ASSETS; NEVER OVERWRITE.
// ==========================================================================

var knownImages = {};
var activeDescriptions = {};
var activeTaskCount = 0;

function loadActiveTasks() {
  if (!CHECK_RUNNING_TASKS) return;

  try {
    var ops = ee.data.listOperations(1000) || [];

    ops.forEach(function(op) {
      var md = op.metadata || {};
      var state = String(md.state || '').toUpperCase();

      if (state === 'PENDING' ||
          state === 'READY' ||
          state === 'RUNNING' ||
          state === 'CANCEL_REQUESTED' ||
          state === 'CANCELLING') {

        activeTaskCount++;

        if (md.description) {
          activeDescriptions[String(md.description)] = true;
        }
      }
    });

    print('ACTIVE OR QUEUED SERVER TASKS:', activeTaskCount);

  } catch(err) {
    print('WARNING: task activity could not be checked:', String(err));
    print('Before rerunning, manually check that no duplicate jobs are active.');
  }
}

function loadInventory() {
  var token = null;
  var count = 0;
  var pages = 0;

  do {
    var params = {pageSize:'1000', view:'BASIC'};

    if (token) params.pageToken = token;

    var result = ee.data.listAssets(DEST_FOLDER, params);

    if (!result) {
      throw new Error('Unable to inventory ' + DEST_FOLDER);
    }

    (result.assets || []).forEach(function(item) {
      if (String(item.type || '')
          .replace(/[^A-Z]/gi,'')
          .toUpperCase() === 'IMAGE') {

        var id = String(item.name || item.id || '');

        if (id) {
          knownImages[id] = true;
          count++;
        }
      }
    });

    token = result.nextPageToken || null;
    pages++;

    if (pages > 100) {
      throw new Error('Too many inventory pages.');
    }

  } while (token);

  print('Existing images in destination folder:', count);
}

if (ACTION !== 'VIRTUAL_QA') {
  loadInventory();
  loadActiveTasks();
}

function exists(id) {
  return Boolean(knownImages[id]);
}

var stagingBandNamesCache = {};

function stageInputNames(y, stageId, names) {
  if (y !== 2024 || !DETECT_2024_LEGACY_STAGING) {
    return names;
  }

  var available = stagingBandNamesCache[stageId];

  if (!available) {
    available = ee.Image(stageId).bandNames().getInfo();
    stagingBandNamesCache[stageId] = available;
  }

  return names.map(function(name) {
    if (available.indexOf(name) >= 0) return name;

    var legacy = String(name).replace(
      /savannas_grasslands_and_wetlands/g,
      'savannas_grasslands_wetlands'
    );

    if (available.indexOf(legacy) >= 0) return legacy;

    throw new Error(
      'Missing staged input band: ' + name + ' in ' + stageId
    );
  });
}

var schemaValidationCache = {};

function existingSchemaOK(id) {
  if (Object.prototype.hasOwnProperty.call(schemaValidationCache,id)) {
    return schemaValidationCache[id];
  }

  try {
    var meta = ee.data.getAsset(id);
    var props = (meta && meta.properties) || {};

    var ok = props.thematic_schema === 'V3_GROUP_BURNED' &&
      Number(props.storage_percent_scale) === 100;

    schemaValidationCache[id] = ok;
    return ok;

  } catch(err) {
    print('Could not verify schema:', id, String(err));
    schemaValidationCache[id] = false;
    return false;
  }
}

// ==========================================================================
// 4. FINE-RESOLUTION INDICATORS, BYTE FLAGS
// ==========================================================================

function rawLulc(y) {
  return ee.Image(
    P + 'lulc/collection11/' +
    'mapbiomas_brazil_collection11_coverage_v3'
  ).select('classification_' + y);
}

function groupMask(lulc,g) {
  return lulc.remap(
    g.classes,
    g.classes.map(function() { return 1; }),
    0
  ).unmask(0,false).toByte().rename('grp_' + g.key);
}

function validMask(lulc) {
  return lulc.neq(0)
    .and(lulc.neq(27))
    .unmask(0,false)
    .rename('lulc_valid')
    .toByte();
}

function annualFire(y) {
  return ee.Image(
    F + 'mapbiomas_fire_collection51_annual_burned_v1'
  ).select('burned_area_' + y)
    .eq(1)
    .unmask(0,false)
    .toByte();
}

function monthlyFire(y,m) {
  return ee.Image(
    F + 'mapbiomas_fire_collection51_monthly_burned_v1'
  ).select('burned_monthly_' + y)
    .eq(m)
    .unmask(0,false)
    .toByte();
}

function annualWater(y) {
  return ee.Image(
    W + 'mapbiomas_brazil_collection5_water_annual_v4'
  ).select('classification_' + y)
    .eq(1)
    .unmask(0,false)
    .toByte();
}

function monthlyWater(y,m) {
  return ee.Image(
    W + 'mapbiomas_brazil_collection5_water_monthly_v4/' +
    'water_monthly_' + y + '_' + pad2(m)
  ).select('water_monthly')
    .eq(m)
    .unmask(0,false)
    .toByte();
}

function themeStack(lulc,fire,water,period) {
  var images = [
    fire.rename('fire_' + period),
    water.rename('water_' + period)
  ];

  FIRE_GROUPS.forEach(function(g) {
    images.push(
      groupMask(lulc,g)
        .and(fire)
        .rename('fire_in_grp_' + g.key)
        .toByte()
    );
  });

  return ee.Image.cat(images);
}

function loggingStack(y, lulcReference) {
  if (!INCLUDE_LOGGING || y < 1988 || y > 2024) {
    // Logging source contains bands only for 1988-2024.
    // For 2025 retain both bands as masked/no-data (NOT zero).
    // Build fully masked placeholders ON THE NATIVE 30m LULC GRID.
    // An ee.Image(0) constant alone has a coarse 1-degree projection.
    // This preserves the two logging bands without contaminating the
    // projection of the annual 30m indicator stack.
    var noLogging = ee.Image(lulcReference)
      .multiply(0).toByte().updateMask(ee.Image.constant(0));
    return ee.Image.cat([
      noLogging.rename('logging_annual'),
      noLogging.rename('logging_source_mask')
    ]);
  }

  var raw = ee.Image(LOGGING_ID).select('logging_' + y);

  return ee.Image.cat([
    raw.eq(1)
      .unmask(0,false)
      .toByte()
      .rename('logging_annual'),

    raw.mask()
      .unmask(0,false)
      .toByte()
      .rename('logging_source_mask')
  ]);
}

// --------------------------------------------------------------------------
// Stage and final reducers
// --------------------------------------------------------------------------

function stageReduce(byteImage, nativeLulcProjection) {
  // CRITICAL PROJECTION FIX:
  // ee.Image.cat/addBands of LULC + Fire + Water + Logging can contain
  // heterogeneous projections. reduceResolution requires one valid default.
  // Set the default to the original 30m LULC projection BEFORE aggregation.
  // This does NOT force a nationwide .reproject() computation or change the
  // final export grid. Other 30m inputs use default nearest-neighbor sampling
  // when they must be aligned to the LULC grid for pixelwise intersections.
  var nativeStack = ee.Image(byteImage)
    .setDefaultProjection(nativeLulcProjection);
  return nativeStack.reduceResolution({
    reducer: ee.Reducer.mean(),
    bestEffort: false,
    maxPixels: STAGE_MAX_PIXELS
  }).set({
    processing_stage: 'national_intermediate',
    stage_grid_divisions: MID_DIVISIONS,
    stage_source_projection: 'MapBiomas C11 native LULC band for year',
    stage_note: 'fine byte masks reduced to 0.1/12-degree fractions'
  });
}

function finalReduce(id,sourceNames,targetNames) {
  var img = ee.Image(id).select(
    sourceNames,
    targetNames || sourceNames
  );

  return img.reduceResolution({
    reducer: ee.Reducer.mean(),
    bestEffort: false,
    maxPixels: FINAL_MAX_PIXELS
  }).reproject({crs:GRID});
}

function pct(numerator,name,denominator) {
  var v = ee.Image(numerator);

  if (denominator) {
    var d = ee.Image(denominator);

    v = v.divide(d.max(1e-12))
      .updateMask(d.gt(0));
  }

  return v.multiply(10000)
    .round()
    .clamp(0,10000)
    .toInt16()
    .rename(name + '_pct');
}

function finalMetadata(image,y,m,cadence) {
  return ee.Image(ee.Image(image).set({
    thematic_schema: 'V3_GROUP_BURNED',
    year: y,
    month: m,
    cadence: cadence,

    'system:time_start':
      ee.Date.fromYMD(y,m || 1,1).millis(),

    storage_percent_scale: 100,
    storage_type: 'Int16',

    encoding: 'stored=round(actual_percentage*100); decode=stored/100',

    group_pct_denominator: 'valid annual LULC area',
    lulc_valid_pct_denominator: 'whole atmosphere cell',
    standalone_fire_water_pct_denominator: 'whole atmosphere cell',

    fire_in_grp_pct_denominator: 'TOTAL area of that LULC group',
    fire_in_grp_undefined: 'masked where group area is zero',

    fire_intersection_definition: 'pixelwise high-res group AND burned',
    lulc_group_definitions: JSON.stringify(LULC_GROUPS),
    fire_excluded_groups: JSON.stringify(FIRE_GROUP_EXCLUSIONS),

    water_group_intersections: false,
    percent_clamping: '0..10000',

    reference_grid: 'MapBiomas Atmosphere C1 0.1-degree EPSG4326',
    climate_exported: false,
    logging_missing_before_1988: true,
    logging_missing_after_2024: true,

    monthly_static_lulc: 'copied from completed annual V3 asset',
    monthly_fire_denominator:
      'unrounded fraction from annual stage LULC',

    source_mask_policy:
      'fine masked inputs filled as zero (logging has coverage)'
  }));
}

function createExport(image,id,intermediate) {
  Export.image.toAsset({
    image: intermediate
      ? image
      : ee.Image(image).clipToCollection(BRAZIL),

    assetId: id,
    description: id.split('/').pop(),
    region: BRAZIL_RECT,

    crs: GRID_INFO.crs,
    crsTransform: intermediate ? MID_TRANSFORM : T,

    maxPixels: 1e13,

    shardSize: intermediate
      ? STAGE_SHARD_SIZE
      : FINAL_SHARD_SIZE,

    pyramidingPolicy: {'.default':'mean'},
    overwrite: false
  });

  print('CREATED TASK:', id);
}

// ==========================================================================
// 5. BATCH PLANNER: DEPENDENCIES AND TASK CREATION
// ==========================================================================

var created = 0;
var planned = 0;
var already = 0;
var blocked = 0;
var considered = 0;

var planList = [];

var taskSlots = MAX_NEW_TASKS_PER_RUN;

// IMPORTANT FIX: project active count is not a draft creation limit.
if (ACTION === 'CREATE' &&
    CHECK_RUNNING_TASKS &&
    ENFORCE_ACTIVE_CAP) {

  taskSlots = Math.max(
    0,
    Math.min(
      MAX_NEW_TASKS_PER_RUN,
      MAX_ACTIVE_TASKS - activeTaskCount
    )
  );
}

print(
  'TASK GENERATION SETTINGS:',
  'BATCH=' + BATCH,
  'ACTION=' + ACTION,
  'new tasks requested=' + MAX_NEW_TASKS_PER_RUN,
  'project running or queued=' + activeTaskCount,
  'enforce cap=' + ENFORCE_ACTIVE_CAP,
  'draft task slots=' + taskSlots
);

if (ACTION === 'CREATE' && taskSlots === 0) {
  print(
    'ZERO DRAFT SLOTS! Set ENFORCE_ACTIVE_CAP=false ' +
    'or reduce the active task load.'
  );
}

function remainingSlots() {
  return taskSlots - created - planned;
}

function submitOne(job,id,requires,build,intermediate) {
  considered++;

  if (exists(id)) {
    if ((job === 'FINAL_ANNUAL' || job === 'FINAL_MONTHS') &&
        !existingSchemaOK(id)) {

      blocked++;

      print(
        'INCOMPATIBLE EXISTING FINAL -- NOT OVERWRITTEN:',
        id
      );

      return;
    }

    already++;
    return;
  }

  if (activeDescriptions[id.split('/').pop()]) {
    already++;

    print('ALREADY SUBMITTED / RUNNING, skipping:', id);

    return;
  }

  if (remainingSlots() <= 0) return;

  var missing = (requires || []).filter(function(req) {
    return !exists(req);
  });

  if (missing.length) {
    blocked++;

    if (blocked <= 12) {
      print('PREREQUISITES NOT COMPLETED:', id, missing);
    }

    return;
  }

  if (job === 'FINAL_MONTHS') {
    var annualReq = annualId(extractYearFromAsset(id));

    if (!existingSchemaOK(annualReq)) {
      blocked++;

      print('Annual V3 schema check failed:', annualReq);

      return;
    }
  }

  if (ACTION === 'PLAN') {
    planned++;

    planList.push({
      job: job,
      asset: id,
      stage: intermediate ? 'intermediate' : 'final'
    });

    return;
  }

  if (ACTION !== 'CREATE') return;

  var result = build();

  createExport(result,id,intermediate);
  created++;
}

function extractYearFromAsset(id) {
  var match = id.match(
    /dh-thematic-atmosphere-data-integration-(\d{4})-/
  );

  if (!match) {
    throw new Error('Cannot parse year from asset: ' + id);
  }

  return Number(match[1]);
}

// ==========================================================================
// 6. PROCESSING FUNCTIONS
// ==========================================================================

function lulcStage(y) {
  var lulc = rawLulc(y);

  return stageReduce(
    ee.Image.cat(
      [validMask(lulc)].concat(
        LULC_GROUPS.map(function(g) {
          return groupMask(lulc,g);
        })
      )
    ),
    lulc.projection()
  ).set({
    source_year: y,
    stage_dataset: 'lulc'
  });
}

function annualThemeStage(y) {
  var lulc = rawLulc(y);

  var theme = themeStack(
    lulc,
    annualFire(y),
    annualWater(y),
    'annual'
  );

  return stageReduce(
    theme.addBands(loggingStack(y, lulc)),
    lulc.projection()
  ).set({
    source_year: y,
    stage_dataset: 'annual_theme'
  });
}

function monthThemeStage(y,pk) {
  var lulc = rawLulc(y);
  var imgs = [];

  pk.months.forEach(function(m) {
    var monthStack = themeStack(
      lulc,
      monthlyFire(y,m),
      monthlyWater(y,m),
      'month'
    );

    var original = MONTHLY_THEME_NAMES;

    var renamed = original.map(function(n) {
      return monthStageBand(n,m);
    });

    imgs.push(
      monthStack.select(original,renamed)
    );
  });

  return stageReduce(ee.Image.cat(imgs), lulc.projection()).set({
    source_year: y,
    stage_dataset: 'monthly_theme',
    start_month: pk.start,
    end_month: pk.end,
    month_pack_size: MONTH_PACK_SIZE
  });
}

function annualFinal(y) {
  var lulc = finalReduce(
    stageLulcId(y),
    stageInputNames(
      y,
      stageLulcId(y),
      LULC_STAGE_NAMES
    ),
    LULC_STAGE_NAMES
  );

  var valid = lulc.select('lulc_valid');

  var result = [
    pct(valid,'lulc_valid')
  ];

  LULC_GROUPS.forEach(function(g) {
    result.push(
      pct(
        lulc.select('grp_' + g.key),
        'grp_' + g.key,
        valid
      )
    );
  });

  var themeNames = ANNUAL_THEME_NAMES.concat(
    LOGGING_STAGE_NAMES
  );

  var theme = finalReduce(
    stageAnnualId(y),
    stageInputNames(
      y,
      stageAnnualId(y),
      themeNames
    ),
    themeNames
  );

  ANNUAL_THEME_NAMES.forEach(function(n) {
    var group = n.indexOf('fire_in_grp_') === 0;

    var denom = group
      ? lulc.select(
          'grp_' + n.slice('fire_in_grp_'.length)
        )
      : null;

    result.push(
      pct(theme.select(n),n,denom)
    );
  });

  result.push(
    pct(theme.select('logging_annual'),'logging_annual')
  );

  result.push(
    pct(
      theme.select('logging_source_mask'),
      'logging_source_coverage'
    )
  );

  return finalMetadata(
    ee.Image.cat(result),
    y,
    0,
    'annual'
  );
}

function monthlyFinal(y,m) {
  var annual = ee.Image(annualId(y));

  var rawNames = MONTHLY_THEME_NAMES.map(function(n) {
    return monthStageBand(n,m);
  });

  var theme = finalReduce(
    stageMonthId(y,m),
    stageInputNames(
      y,
      stageMonthId(y,m),
      rawNames
    ),
    MONTHLY_THEME_NAMES
  );

  var groups = LULC_GROUPS.map(function(g) {
    return 'grp_' + g.key;
  });

  var lulc = finalReduce(
    stageLulcId(y),
    stageInputNames(
      y,
      stageLulcId(y),
      groups
    ),
    groups
  );

  var out = [
    annual.select(LULC_OUT_NAMES)
  ];

  MONTHLY_THEME_NAMES.forEach(function(n) {
    var group = n.indexOf('fire_in_grp_') === 0;

    var denom = group
      ? lulc.select(
          'grp_' + n.slice('fire_in_grp_'.length)
        )
      : null;

    out.push(
      pct(theme.select(n),n,denom)
    );
  });

  return finalMetadata(
    ee.Image.cat(out),
    y,
    m,
    'monthly'
  );
}

// ==========================================================================
// 7. TWO-BATCH AUTOMATIC PLANNER
// ==========================================================================

function finishExistingAnnual(y) {
  return exists(annualId(y)) &&
    existingSchemaOK(annualId(y));
}

function requireAllAnnualProducts() {
  var missing = [];

  for (var y = YEAR_START; y <= YEAR_END; y++) {
    if (!finishExistingAnnual(y)) {
      missing.push(y);
    }
  }

  if (missing.length) {
    print(
      'MONTHLY batch gated: annual V3 assets missing for years:',
      missing
    );

    print(
      'Run BATCH=ANNUAL until these annual final assets COMPLETE.'
    );
  }

  return missing.length === 0;
}

function createAnnualBatch() {
  print(
    'ANNUAL BATCH: starting from',
    YEAR_START,
    'through',
    YEAR_END,
    'with',
    taskSlots,
    'draft slots. Each missing year creates up to TWO staging tasks.'
  );

  for (var y = YEAR_START; y <= YEAR_END; y++) {
    if (remainingSlots() <= 0) break;

    if (finishExistingAnnual(y)) {
      already++;
      continue;
    }

    var lid = stageLulcId(y);
    var aid = stageAnnualId(y);

    if (!exists(lid)) {
      submitOne(
        'STAGE_LULC',
        lid,
        [],
        (function(yy) {
          return function() {
            return lulcStage(yy);
          };
        })(y),
        true
      );
    }

    if (remainingSlots() <= 0) break;

    if (!exists(aid)) {
      submitOne(
        'STAGE_ANNUAL',
        aid,
        [],
        (function(yy) {
          return function() {
            return annualThemeStage(yy);
          };
        })(y),
        true
      );
    }

    if (remainingSlots() <= 0) break;

    if (exists(lid) && exists(aid)) {
      submitOne(
        'FINAL_ANNUAL',
        annualId(y),
        [lid,aid],
        (function(yy) {
          return function() {
            return annualFinal(yy);
          };
        })(y),
        false
      );
    }
  }
}

function createMonthlyBatch() {
  var visited = {};

  for (var y = YEAR_START; y <= YEAR_END; y++) {
    if (remainingSlots() <= 0) break;

    if (!finishExistingAnnual(y) ||
        !exists(stageLulcId(y))) {

      blocked++;

      if (blocked <= 12) {
        print(
          'MONTHLY BLOCKED - missing annual V3 or staged LULC:',
          y
        );
      }

      continue;
    }

    for (var m = MONTH_START; m <= MONTH_END; m++) {
      if (remainingSlots() <= 0) break;

      if (exists(monthlyId(y,m))) {
        if (!existingSchemaOK(monthlyId(y,m))) {
          blocked++;

          if (blocked <= 12) {
            print(
              'INCOMPATIBLE MONTHLY OUTPUT:',
              monthlyId(y,m)
            );
          }
        } else {
          already++;
        }

        continue;
      }

      var sid = stageMonthId(y,m);

      if (!exists(sid) && !visited[sid]) {
        visited[sid] = true;
        var pk = monthPack(m);

        submitOne(
          'STAGE_MONTHS',
          sid,
          [],
          (function(yy,pp) {
            return function() {
              return monthThemeStage(yy,pp);
            };
          })(y,pk),
          true
        );
      }

      if (remainingSlots() <= 0) break;

      if (exists(sid)) {
        submitOne(
          'FINAL_MONTHS',
          monthlyId(y,m),
          [
            sid,
            stageLulcId(y),
            annualId(y)
          ],
          (function(yy,mm) {
            return function() {
              return monthlyFinal(yy,mm);
            };
          })(y,m),
          false
        );
      }
    }
  }
}

// --------------------------------------------------------------------------
// Run batch planner
// --------------------------------------------------------------------------

if (ACTION === 'CREATE' || ACTION === 'PLAN') {

  if (BATCH === 'ANNUAL') {
    createAnnualBatch();
  }

  if (BATCH === 'MONTHLY' &&
      (!REQUIRE_ALL_ANNUALS || requireAllAnnualProducts())) {
    createMonthlyBatch();
  }

  print(
    'BATCH:', BATCH,
    'ACTION:', ACTION,
    'Years:', YEAR_START, '-', YEAR_END,
    'Months:', MONTH_START, '-', MONTH_END
  );

  print(
    'TASKS GENERATED:', created,
    'NEXT TASKS PLANNED:', planned,
    'ALREADY PRESENT OR ACTIVE:', already,
    'BLOCKED:', blocked
  );

  if (ACTION === 'PLAN') {
    print('NEXT TASKS (NO EXPORT CREATED):', planList);
  }

  if (ACTION === 'CREATE') {
    print(
      'Start tasks in Tasks tab, wait until COMPLETED, then Run again.'
    );
  }

  print(
    'Active-or-queued server tasks reported:',
    activeTaskCount,
    'New-task allowance this run:',
    taskSlots
  );

  if (ACTION === 'CREATE' && created === 0) {
    print(
      'NO TASKS GENERATED. Diagnose using: draft slots, ' +
      'existing assets, active task descriptions, ' +
      'prerequisites, and first error above.'
    );

    if (BATCH === 'MONTHLY') {
      print(
        'MONTHLY requires the final annual V3 assets FIRST.'
      );
    }

    print(
      'For a minimal ANNUAL test set YEAR_START=1985, ' +
      'YEAR_END=1985, MAX_NEW_TASKS_PER_RUN=2, ' +
      'ENFORCE_ACTIVE_CAP=false.'
    );
  }

  print(
    'Export calls create drafts in the TASKS tab. ' +
    'Click Run on each draft to submit it; no exports auto-start.'
  );

  print(
    'Annual: 17 Int16 bands | monthly: 15 Int16 bands | stored pct / 100.'
  );

  print(
    'MONTHLY reuses the final annual LULC bands, ' +
    'and staged LULC area denominators.'
  );
}

// ==========================================================================
// 8. VIRTUAL ATMOSPHERE + HEATWAVES FOR ZONAL STATISTICS
// ==========================================================================

function indexed(collection,index,band,out) {
  return ee.Image(
    ee.ImageCollection(collection)
      .filter(ee.Filter.eq('system:index',index))
      .first()
  ).select(band).rename(out);
}

function masked(name) {
  return ee.Image(0)
    .rename(name)
    .updateMask(ee.Image(0));
}

function annualClimate(y) {
  var ra = RAIN_ALL.select(
    'precipitation_' + y
  ).rename('precip_mm');

  var names = [];

  for (var z = 1985; z <= 2024; z++) {
    names.push('precipitation_' + z);
  }

  var base = RAIN_ALL.select(names)
    .reduce(ee.Reducer.mean());

  var ta = A +
    'mapbiomas_brazil_collection1_air_temperature_annual_v2';

  var pre = 'mapbiomas_brazil_collection1_air_temperature_';

  return ee.Image.cat([
    ra,

    ra.subtract(base).rename('precip_anomaly_mm'),

    indexed(
      ta,
      pre + 'mean_annual_v2',
      'temperature_' + y,
      'temp_mean_c'
    ),

    indexed(
      ta,
      pre + 'min_annual_v2',
      'temperature_' + y,
      'temp_min_c'
    ),

    indexed(
      ta,
      pre + 'max_annual_v2',
      'temperature_' + y,
      'temp_max_c'
    ),

    y >= 2003
      ? ee.Image(
          A + 'mapbiomas_brazil_collection1_pm2p5_annual_v2'
        ).select('pm2p5_' + y)
          .rename('pm25_ug_m3')
      : masked('pm25_ug_m3')
  ]);
}

function monthlyClimate(y,m) {
  var tm = A +
    'mapbiomas_brazil_collection1_air_temperature_monthly_v2';

  return ee.Image.cat([
    indexed(
      A + 'mapbiomas_brazil_collection1_precipitation_monthly_v2',
      'precipitation_' + m + '_v2',
      'precipitation_' + y,
      'precip_mm'
    ),

    indexed(
      A + 'mapbiomas_brazil_collection1_precipitation_anomaly_monthly_v2',
      'precipitation_anomaly_' + m + '_v2',
      'precipitation_anomaly_' + y,
      'precip_anomaly_mm'
    ),

    indexed(
      tm,
      'temperature_mean_' + m + '_v2',
      'temperature_' + y,
      'temp_mean_c'
    ),

    indexed(
      tm,
      'temperature_minimum_' + m + '_v2',
      'temperature_' + y,
      'temp_min_c'
    ),

    indexed(
      tm,
      'temperature_maximum_' + m + '_v2',
      'temperature_' + y,
      'temp_max_c'
    ),

    y >= 2003
      ? indexed(
          A + 'mapbiomas_brazil_collection1_pm2p5_monthly_v2',
          'pm2p5_' + m + '_v2',
          'pm2p5_' + y,
          'pm25_ug_m3'
        )
      : masked('pm25_ug_m3')
  ]);
}

function heatwaveDays(y,m) {
  var leaf = m === 0
    ? 'annual_' + y + '_m' + HEATWAVE_SPEC_VERSION
    : 'monthly_' + y + '_' + pad2(m) +
      '_m' + HEATWAVE_SPEC_VERSION;

  return ee.Image(HW_FOLDER + '/' + leaf)
    .select('heatwave_days')
    .rename('heatwave_days');
}

function virtualAnnual(y) {
  var image = ee.Image(annualId(y))
    .toFloat()
    .divide(100)
    .addBands(annualClimate(y));

  if (INCLUDE_HEATWAVES_IN_VIRTUAL) {
    image = image.addBands(heatwaveDays(y,0));
  }

  return image.set({
    year: y,
    month: 0,
    cadence: 'annual',
    'system:time_start': ee.Date.fromYMD(y,1,1).millis()
  });
}

function virtualMonthly(y,m) {
  var image = ee.Image(monthlyId(y,m))
    .toFloat()
    .divide(100)
    .addBands(monthlyClimate(y,m));

  if (INCLUDE_HEATWAVES_IN_VIRTUAL) {
    image = image.addBands(heatwaveDays(y,m));
  }

  return image.set({
    year: y,
    month: m,
    cadence: 'monthly',
    annual_lulc_source: annualId(y),
    'system:time_start': ee.Date.fromYMD(y,m,1).millis()
  });
}

// --------------------------------------------------------------------------
// Virtual QA
// --------------------------------------------------------------------------

if (ACTION === 'VIRTUAL_QA') {
  print(
    'VIRTUAL annual bands:',
    virtualAnnual(QA_YEAR).bandNames()
  );

  print(
    'VIRTUAL monthly bands:',
    virtualMonthly(QA_YEAR,QA_MONTH).bandNames()
  );

  print(
    'Thematic units = real 0..100 percent; ' +
    'climate/heatwave = source units.'
  );

  if (SHOW_VIRTUAL_MAP) {
    Map.centerObject(BRAZIL,4);

    Map.addLayer(
      virtualMonthly(QA_YEAR,QA_MONTH).select('grp_forest_pct'),
      {
        min:0,
        max:100,
        palette:['ffffe5','78c679','006837']
      },
      'Decoded forest share',
      true
    );
  }
}

// ==========================================================================
// 9. AUDIT AVAILABLE ASSETS
// ==========================================================================

if (ACTION === 'AUDIT') {
  print(
    'AUDIT only: no tasks generated. Set ACTION=PLAN or CREATE.'
  );

  var rows = [];

  for (var ay = YEAR_START; ay <= YEAR_END; ay++) {
    var finalMonths = 0;
    var checkedPacks = {};
    var monthPacksAvailable = 0;

    for (var am = MONTH_START; am <= MONTH_END; am++) {
      if (exists(monthlyId(ay,am))) {
        finalMonths++;
      }

      var ai = stageMonthId(ay,am);

      if (!checkedPacks[ai]) {
        checkedPacks[ai] = true;

        if (exists(ai)) {
          monthPacksAvailable++;
        }
      }
    }

    rows.push({
      year: ay,
      lulc_stage: exists(stageLulcId(ay)),
      annual_theme_stage: exists(stageAnnualId(ay)),
      monthly_stage_packs_available: monthPacksAvailable,
      annual_V3_final:
        exists(annualId(ay)) &&
        existingSchemaOK(annualId(ay)),
      monthly_finals: finalMonths
    });
  }

  print(
    'Available assets for selected year/month range:',
    rows
  );

  print(
    'Already completed 2024 staging is reusable when band names match.'
  );

  print(
    'Annual batch first, then monthly batch.'
  );
}

// V4: All stageReduce() inputs now have a native 30m LULC default projection.
// END: switch BATCH from ANNUAL to MONTHLY only after annual outputs COMPLETE.
