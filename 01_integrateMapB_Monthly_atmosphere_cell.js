/**
 * MAPBIOMAS BRAZIL | MONTHLY 2025 | NO LOGGING | CODE EDITOR | V5.1
 * ========================================================
 * PURPOSE: create 2025 monthly products AFTER annual V3
 *           final assets and annual LULC intermediates have been exported.
 *
 * - Runs in Google's EARTH ENGINE CODE EDITOR (JavaScript, not Node/Python).
 * - Browser-safe: creates up to MAX_NEW_TASKS_PER_RUN draft tasks per Run.
 * - A completed intermediate_monthly asset leads to its final monthly export.
 * - Uses saved annual LULC bands and saved annual intermediate LULC fractions.
 * - Monthly 30m fire-by-LULC intersections calculated BEFORE aggregation.
 * - Native 30m LULC projection specified before reduceResolution (V4 fix).
 * - 15 signed Int16 percentage bands. Stored integer = actual percent x 100.
 * - Fire in group = BURNED GROUP AREA / TOTAL GROUP AREA (not whole cell).
 * - No water-by-group intersections. Climate & heatwaves NOT duplicated.
 * - NO LOGGING: monthly output has 15 bands and references NO logging source.
 * - Requires completed 2025 annual final + 2025 intermediate LULC.
 *
 * NOTE: Code Editor does NOT automatically start batch tasks. After pressing
 * Run here, click Run on the newly created exports in the Tasks tab.
 * A submitted task persists; an unsubmitted draft does NOT survive closing
 * or refreshing the Code Editor page.
 */

// ======================== EDIT THESE SETTINGS ============================
var ACTION = 'CREATE';                // 'PLAN' (preview only) or 'CREATE'
var YEAR_START = 1985;                // 2025 only
var YEAR_END = 2025;
var MONTH_START = 1;
var MONTH_END = 12;
var MAX_NEW_TASKS_PER_RUN = 12;       // Suggested 12; keep <= 24 initially
var CHECK_ACTIVE_SERVER_TASKS = true;

var DEST_FOLDER = 'projects/mapbiomas-brazil/assets/DEGRADATION/' +
  'COLLECTION-11/atmosphere/test';
// Create 12 monthly intermediate drafts, then rerun when finished for 12 finals.
// ========================================================================

if (['CREATE','PLAN'].indexOf(ACTION) < 0) throw new Error('Invalid ACTION');
if (YEAR_START < 1985 || YEAR_END > 2025 || YEAR_END < YEAR_START)
  throw new Error('Year range must be 1985..2025, with START <= END');
if (MONTH_START < 1 || MONTH_END > 12 || MONTH_END < MONTH_START)
  throw new Error('Month range must be 1..12');
if (MAX_NEW_TASKS_PER_RUN < 1 || MAX_NEW_TASKS_PER_RUN > 48)
  throw new Error('Use 1..48 draft tasks per run to protect the browser');

function pad2(n) { return ('0' + n).slice(-2); }
function groupKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g,'_')
    .replace(/^_+|_+$/g,'');
}

var GROUPS = [
  {name:'Forest', classes:[3,5,6,49]},
  {name:'Savannas, Grasslands and Wetlands',
   classes:[4,7,12,77,11,84,50,32,29]},
  {name:'Pasture', classes:[15]},
  {name:'Agriculture', classes:[19,39,20,40,62,41,36,46,47,35,48]},
  {name:'Mosaic of uses', classes:[21]},
  {name:'Farming', classes:[15,19,39,20,40,62,41,36,46,47,35,48,9]},
  {name:'Urban', classes:[24]}
];
GROUPS.forEach(function(g) { g.key = groupKey(g.name); });
var FIRE_GROUPS = GROUPS.filter(function(g) {
  return g.name !== 'Mosaic of uses' && g.name !== 'Urban';
});
var MONTH_NAMES = ['fire_month','water_month'].concat(
  FIRE_GROUPS.map(function(g) {return 'fire_in_grp_' + g.key;})
);
var LULC_FINAL_NAMES = ['lulc_valid_pct'].concat(
  GROUPS.map(function(g) {return 'grp_' + g.key + '_pct';})
);
var LULC_STAGE_NAMES = GROUPS.map(function(g) {return 'grp_' + g.key;});

var PUBLIC_ROOT = 'projects/mapbiomas-public/assets/brazil/';
var LULC_ID = PUBLIC_ROOT + 'lulc/collection11/' +
  'mapbiomas_brazil_collection11_coverage_v3';
var FIRE_MONTHLY_ID = PUBLIC_ROOT + 'fire/collection5_1/' +
  'mapbiomas_fire_collection51_monthly_burned_v1';
var WATER_MONTHLY_ROOT = PUBLIC_ROOT + 'water/collection5/' +
  'mapbiomas_brazil_collection5_water_monthly_v4/';
var ATM_PRECIP_ID = PUBLIC_ROOT + 'atmosphere/collection1/' +
  'mapbiomas_brazil_collection1_precipitation_annual_v2';

var GRID = ee.Image(ATM_PRECIP_ID).select('precipitation_2024').projection();
var GRID_INFO = GRID.getInfo();
var T = GRID_INFO.transform;
if (!T || T.length !== 6) throw new Error('Cannot read atmosphere grid');
var MID_T = [T[0]/12,T[1]/12,T[2],T[3]/12,T[4]/12,T[5]];
var EXPORT_RECT = ee.Geometry.Rectangle([-75,-35,-28,6],null,false);
var BRAZIL = ee.FeatureCollection('FAO/GAUL/2015/level0')
  .filter(ee.Filter.eq('ADM0_NAME','Brazil'));

function baseName(y) {
  return 'dh-thematic-atmosphere-data-integration-' + y + '-';
}
function annualId(y) {return DEST_FOLDER + '/' + baseName(y) + '00-annual';}
function lulcStageId(y) {
  return DEST_FOLDER + '/' + baseName(y) + '00-intermediate-lulc';
}
function monthlyStageId(y,m) {
  return DEST_FOLDER + '/' + baseName(y) + pad2(m) + '-intermediate-monthly';
}
function monthlyFinalId(y,m) {
  return DEST_FOLDER + '/' + baseName(y) + pad2(m) + '-monthly';
}

// One inventory request per page; much lighter than one asset lookup/month.
var existing = {};
var pages = 0;
var token = null;
do {
  var opts = {pageSize:'1000',view:'BASIC'};
  if (token) opts.pageToken = token;
  var listed = ee.data.listAssets(DEST_FOLDER,opts);
  (listed.assets || []).forEach(function(asset) {
    var id = String(asset.name || asset.id || '');
    if (id) existing[id] = true;
  });
  token = listed.nextPageToken || null;
  pages++;
  if (pages > 100) throw new Error('Excessive asset inventory pages');
} while (token);
function exists(id) {return Boolean(existing[id]);}

// Avoid a duplicate submission if the same job is already queued/running.
var active = {};
if (CHECK_ACTIVE_SERVER_TASKS) {
  try {
    var operations = ee.data.listOperations(1000) || [];
    operations.forEach(function(op) {
      var md = op.metadata || {};
      var state = String(md.state || '').toUpperCase();
      if (['PENDING','READY','RUNNING','CANCEL_REQUESTED'].indexOf(state) >= 0 &&
          md.description) active[String(md.description)] = true;
    });
  } catch (err) {
    print('WARNING: Active-task check unavailable:',String(err));
  }
}

function annualOK(y) {
  var id = annualId(y);
  if (!exists(id) || !exists(lulcStageId(y))) return false;
  // Check schema once per year, not once for every month.
  var metadata = ee.data.getAsset(id);
  var props = metadata.properties || {};
  return props.thematic_schema === 'V3_GROUP_BURNED' &&
    Number(props.storage_percent_scale) === 100;
}

// Old 2024 intermediate assets sometimes omit '_and_' from this group key.
function adaptedStageNames(assetId,names,y) {
  if (y !== 2024) return names;
  var actual = ee.Image(assetId).bandNames().getInfo();
  return names.map(function(n) {
    if (actual.indexOf(n) >= 0) return n;
    var old = n.replace(/savannas_grasslands_and_wetlands/g,
      'savannas_grasslands_wetlands');
    if (actual.indexOf(old) >= 0) return old;
    throw new Error('Staged band missing: ' + n + ' from ' + assetId);
  });
}

function groupFlag(lulc,g) {
  return lulc.remap(g.classes,g.classes.map(function(){return 1;}),0)
    .unmask(0,false).toByte().rename('grp_' + g.key);
}

function monthlyStage(y,m) {
  var lulc = ee.Image(LULC_ID).select('classification_' + y);
  var fire = ee.Image(FIRE_MONTHLY_ID).select('burned_monthly_' + y)
    .eq(m).unmask(0,false).toByte().rename('fire_month');
  // MapBiomas Water Collection 5 monthly asset is month-coded, NOT binary.
  var water = ee.Image(WATER_MONTHLY_ROOT + 'water_monthly_' + y +
    '_' + pad2(m)).select('water_monthly')
    .eq(m).unmask(0,false).toByte().rename('water_month');

  var bands = [fire,water];
  FIRE_GROUPS.forEach(function(g) {
    bands.push(groupFlag(lulc,g).and(fire)
      .rename('fire_in_grp_' + g.key).toByte());
  });
  // Critical projection fix: prevents invalid 30m multiband projection.
  return ee.Image.cat(bands).setDefaultProjection(lulc.projection())
    .reduceResolution({reducer:ee.Reducer.mean(),
      bestEffort:false,maxPixels:4096})
    .set({year:y,month:m,stage_dataset:'monthly_theme',
      stage_grid_divisions:12});
}

function fractionFromStage(assetId,rawNames,outNames,y) {
  var translated = adaptedStageNames(assetId,rawNames,y);
  return ee.Image(assetId).select(translated,outNames)
    .reduceResolution({reducer:ee.Reducer.mean(),
      bestEffort:false,maxPixels:256})
    .reproject({crs:GRID});
}

function encodePct(frac,name,denominator) {
  var result = ee.Image(frac);
  if (denominator) {
    var d = ee.Image(denominator);
    result = result.divide(d.max(1e-12)).updateMask(d.gt(0));
  }
  return result.multiply(10000).round().clamp(0,10000)
    .toInt16().rename(name + '_pct');
}

function monthlyFinal(y,m) {
  // 8 LULC annual bands are copied byte-for-byte from final annual asset.
  var annualLulc = ee.Image(annualId(y)).select(LULC_FINAL_NAMES);
  var theme = fractionFromStage(
    monthlyStageId(y,m),MONTH_NAMES,MONTH_NAMES,y);
  // Denominators must use unrounded annual stage, not Int16 annual fractions.
  var groupArea = fractionFromStage(
    lulcStageId(y),LULC_STAGE_NAMES,LULC_STAGE_NAMES,y);

  var out = [annualLulc];
  MONTH_NAMES.forEach(function(name) {
    var isGroup = name.indexOf('fire_in_grp_') === 0;
    var denom = isGroup ?
      groupArea.select('grp_' + name.slice('fire_in_grp_'.length)) : null;
    out.push(encodePct(theme.select(name),name,denom));
  });
  return ee.Image.cat(out).set({
    thematic_schema:'V3_GROUP_BURNED', storage_percent_scale:100,
    storage_type:'Int16',year:y,month:m,cadence:'monthly',
    'system:time_start':ee.Date.fromYMD(y,m,1).millis(),
    encoding:'stored=round(actual_percentage*100); decode=stored/100',
    fire_in_grp_pct_denominator:'total area of that LULC group',
    standalone_fire_water_pct_denominator:'whole atmosphere grid cell',
    monthly_static_lulc:'copied from annual V3 asset',
    monthly_fire_denominator:'unrounded annual intermediate LULC fraction',
    water_group_intersections:false,
    reference_grid:'MapBiomas Atmosphere C1 EPSG4326 0.1 degrees'
  });
}

function exportOne(image,id,isStage) {
  Export.image.toAsset({
    image:isStage ? image : ee.Image(image).clipToCollection(BRAZIL),
    description:id.split('/').pop(),assetId:id,
    region:EXPORT_RECT,crs:GRID_INFO.crs,
    crsTransform:isStage ? MID_T : T,
    maxPixels:1e13,shardSize:isStage ? 16 : 32,
    pyramidingPolicy:{'.default':'mean'},overwrite:false
  });
}

var proposed = 0,skipped = 0,blocked = 0;
for (var year=YEAR_START;year<=YEAR_END;year++) {
  if (proposed >= MAX_NEW_TASKS_PER_RUN) break;
  if (!annualOK(year)) {
    print('BLOCKED YEAR: first complete the 2025 final annual V3 asset AND the 2025 annual intermediate LULC asset:',year);
    blocked++;continue;
  }
  for (var month=MONTH_START;month<=MONTH_END;month++) {
    if (proposed >= MAX_NEW_TASKS_PER_RUN) break;
    var finalId = monthlyFinalId(year,month);
    var stageId = monthlyStageId(year,month);
    if (exists(finalId) || active[finalId.split('/').pop()]) {
      skipped++;continue;
    }
    var isStage = !exists(stageId);
    var targetId = isStage ? stageId : finalId;
    if (active[targetId.split('/').pop()]) {skipped++;continue;}
    if (ACTION === 'CREATE') {
      exportOne(isStage ? monthlyStage(year,month) :
        monthlyFinal(year,month),targetId,isStage);
    }
    proposed++;
    print((ACTION==='PLAN' ? 'PLANNED' : 'DRAFT CREATED') +
      ': ' + (isStage?'STAGE':'FINAL') + ' ' + year + '-' + pad2(month));
  }
}
print('MONTHLY RUN RESULT:',ACTION,'drafts/planned:',proposed,
  'already completed or active:',skipped,'blocked years:',blocked);
print('Current selected years:',YEAR_START,'..',YEAR_END,
  'months:',MONTH_START,'..',MONTH_END);
print('IMPORTANT: Tasks are drafts; manually click Run in the Tasks tab.');
print('After stages complete, run this SAME script again for final assets.');
print('Final asset: 15 Int16 percentage bands on exact 0.1-degree grid.');
print('NO LOGGING: 2025 monthly script never reads logging_v2 or logging_2025.');
