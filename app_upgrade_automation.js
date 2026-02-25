/* ===================================================================
   Batch Application/Plugin Upgrade Using CI/CD
   @author: Bikash Hembrom
   @purpose:
       - Identify upgradeable Store applications/plugins
       - Trigger CI/CD batch installs in groups of 5
       - Poll every 5 minutes until each batch completes
       - Automatically move to the next batch
       - Use Basic Auth credentials stored in sys_properties

   @param {Int} BATCH_SIZE
       - Number of applications/plugins to install per batch

   @param {Int} POLL_INTERVAL_MS
       - Time interval (ms) between each progress‑check cycle

   @param {Int} MAX_POLL_CYCLES
       - Maximum number of progress‑poll cycles allowed per batch

   @param {Boolean} DRY_RUN
       - If true, prints planned actions without performing installations

   @param {Boolean} LOAD_DEMO_DATA_DEFAULT
       - Default demo‑data behavior when not preserving existing app state

   @param {Boolean} PRESERVE_DEMO_DATA
       - If false, ignores the app’s current demo‑data state and uses LOAD_DEMO_DATA_DEFAULT

   @param {Int} APP_LIMIT
       - Maximum number of applications considered for upgrade

   @param {Boolean} INCLUDE_SYSTEM_APPS
       - If true, system apps (names starting with "@") are included in upgrade checks

   @instruction: Before you run it
       - Create a CI/CD Technical User with required role(s):
             sn_cicd.sys_ci_automation

       - Add Basic Auth system properties:
             sn.cicd.api.user = <username>
             sn.cicd.api.pwd  = <password>

       - Ensure CI/CD plugin (sn_cicd_spoke) is installed and user can call:
             POST /api/sn_cicd/app/batch/install
             GET  /api/sn_cicd/progress/{progress_id}
             GET  /api/sn_cicd/app/batch/results/{results_id}

       - Set INCLUDE_SYSTEM_APPS = false to exclude system (“@”) apps

       - Set DRY_RUN = true to test without triggering installs

   =================================================================== */

(function() {
    // ====================== CONFIG ======================
    var BATCH_SIZE = 5;
    var POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    var MAX_POLL_CYCLES = 72; // 6 hours max
    var PREFIX = "[BATCH PLUGIN UPGRADE SCRIPT]";
    var DRY_RUN = false; // set true to test without installing

    // Reuse your existing discovery config:
    var LOAD_DEMO_DATA_DEFAULT = false;
    var PRESERVE_DEMO_DATA = false;
    var APP_LIMIT = 5;
    var INCLUDE_SYSTEM_APPS = true;

    // ====================== LOGGING ======================
    function ts() {
        return new GlideDateTime().getDisplayValue();
    }

    function info(m) {
        gs.info(PREFIX + " " + ts() + " - " + m);
    }

    function warn(m) {
        gs.warn(PREFIX + " " + ts() + " - " + m);
    }

    function err(m) {
        gs.error(PREFIX + " " + ts() + " - " + m);
    }

    // ================== BASIC AUTH ======================
    function setBasicAuth(r) {
        var user = gs.getProperty("sn.cicd.api.user", "");
        var pwd = gs.getProperty("sn.cicd.api.pwd", "");

        if (!user || !pwd) {
            throw "Missing sn.cicd.api.user or sn.cicd.api.pwd properties!";
        }
        r.setBasicAuth(user, pwd);
    }

    // ================= VERSION COMPARATOR ==================
    function versionCompare(v1, v2) {
        if (v1 === v2) return 0;
        var a = v1.split("."),
            b = v2.split(".");
        for (var i = 0; i < Math.max(a.length, b.length); i++) {
            var ai = +(a[i] || "0");
            var bi = +(b[i] || "0");
            if (ai > bi) return 1;
            if (ai < bi) return -1;
        }
        return 0;
    }

    // =============== DEMO DATA LOGIC) =====================
    function shouldLoadDemoData(storeRec) {
        if (!PRESERVE_DEMO_DATA) return LOAD_DEMO_DATA_DEFAULT;
        return String(storeRec.getValue("demo_data")) === "demo_data_loaded";
    }

    // =============== CHUNK ARRAY FOR BATCHES =====================
    function chunk(arr, size) {
        var out = [];
        for (var i = 0; i < arr.length; i += size)
            out.push(arr.slice(i, i + size));
        return out;
    }

    // ======================================================================
    //                  *** Determine Upgradeable Applications/Plugins ***
    // ======================================================================

    var BUILD_NAME = gs.getProperty('glide.buildname', '');
    if (!BUILD_NAME) {
        warn("glide.buildname property is empty. Compatibility filtering may be inaccurate.");
    }

    var BASE_URI = (gs.getProperty('glide.servlet.uri') || '').replace(/\/+$/, '');

    var prevName = null;
    var appsArray = [];
    var updateCnt = 0;
    var limitReached = false;

    var storeQuery = "update_available=true^compatibilitiesLIKE" + BUILD_NAME;
    if (!INCLUDE_SYSTEM_APPS) storeQuery += "^nameNOT LIKE@";

    var grStore = new GlideRecord("sys_store_app");
    grStore.addEncodedQuery(storeQuery);
    grStore.orderBy("name");
    grStore.orderBy("version");
    grStore.query();

    var t0 = new Date().getTime();

    while (grStore.next()) {
        var curName = grStore.getValue("name");
        var installedVersion = grStore.getValue("version");
        var storeSysId = grStore.getUniqueValue();

        // Deduplicate by name (process only the first row of each name group)
        if (prevName !== null && curName === prevName) {
            continue;
        }

        // Build version query: same app id, compatible with this family, and not the installed version
        var versionQuery = "source_app_id=" + storeSysId +
            "^compatibilitiesLIKE" + BUILD_NAME +
            "^version!=" + installedVersion;

        var grVer = new GlideRecord("sys_app_version");
        grVer.addEncodedQuery(versionQuery);
        grVer.orderByDesc("version");
        grVer.query();

        // Find the highest strictly greater compatible version
        var bestVersion = installedVersion;
        var foundHigher = false;

        while (grVer.next()) {
            var candidate = grVer.getValue("version");
            if (versionCompare(candidate, bestVersion) === 1) {
                bestVersion = candidate;
                foundHigher = true;
            }
        }

        if (foundHigher) {
            var appObj = {
                id: storeSysId,
                load_demo_data: shouldLoadDemoData(grStore),
                displayName: curName,
                type: "application",
                requested_version: bestVersion,
                current_version: installedVersion
            };

            if (appsArray.length < APP_LIMIT) {
                appsArray.push(appObj);
                updateCnt++;
            } else {
                limitReached = true;
                break;
            }
        }

        prevName = curName;
    }

    var t1 = new Date().getTime();
    var elapsedMs = t1 - t0;

    // Discovery summary log for Upgradeable Applications
    if (appsArray.length > 0) {
        var time = new GlideDateTime();
        var payloadPreview = {
            packages: appsArray,
            name: 'Batch Applications Update via CI/CD - ' + time.getDisplayValue()
        };

        var report = PREFIX;
        if (limitReached) {
            report += "\n\n!!!!!!!!!!!! ATTENTION - LIMIT OF " + APP_LIMIT + " HAS BEEN REACHED !!!!!!!!!!";
        }
        report += "\n\nA total of " + updateCnt + " plugins will be upgraded";
        report += "\nElapsed time: " + elapsedMs + " ms";

        gs.print(report + "\n\nUpgradeable Applications:\n\n" + JSON.stringify(payloadPreview, null, 2));

    } else {
        info("No application has been found (elapsed " + elapsedMs + " ms)");
        return;
    }

    // ======================================================================
    //             *** CI/CD AUTOMATION STARTS FROM HERE ***
    // ======================================================================

    info("Total apps requiring upgrade: " + appsArray.length);

    var batches = chunk(appsArray, BATCH_SIZE);
    info("Total batches: " + batches.length);

    // ------------------------ REST HELPERS ------------------------

    function postBatchInstall(payload) {
        var r = new sn_ws.RESTMessageV2();
        r.setHttpMethod("post");
        r.setEndpoint(BASE_URI + "/api/sn_cicd/app/batch/install");
        r.setRequestHeader("Accept", "application/json");
        r.setRequestHeader("Content-Type", "application/json");
        setBasicAuth(r);
        r.setRequestBody(JSON.stringify(payload));

        var res = r.execute();
        var body = res.getBody();
        var parsed;
        try {
            parsed = new global.JSON().decode(body);
        } catch (e) {
            throw "Failed to parse install response. HTTP " + res.getStatusCode() + " Body: " + body;
        }

        if (!parsed || !parsed.result || !parsed.result.links || !parsed.result.links.progress || !parsed.result.links.progress.id) {
            throw "Invalid CI/CD install response: " + body;
        }

        return {
            progressId: parsed.result.links.progress.id,
            resultsId: parsed.result.links.results ? parsed.result.links.results.id : null
        };
    }

    function getProgress(pid) {
        var r = new sn_ws.RESTMessageV2();
        r.setHttpMethod("get");
        r.setEndpoint(BASE_URI + "/api/sn_cicd/progress/" + pid);
        r.setRequestHeader("Accept", "application/json");
        setBasicAuth(r);

        var res = r.execute();
        var body = res.getBody();
        var parsed;
        try {
            parsed = new global.JSON().decode(body);
        } catch (e) {
            throw "Failed to parse progress response. HTTP " + res.getStatusCode() + " Body: " + body;
        }

        if (!parsed || !parsed.result) {
            throw "Invalid progress response: " + body;
        }
        return parsed.result;
    }

    function getBatchResults(resultsId) {
        if (!resultsId) return null;
        var r = new sn_ws.RESTMessageV2();
        r.setHttpMethod("get");
        r.setEndpoint(BASE_URI + "/api/sn_cicd/app/batch/results/" + resultsId);
        r.setRequestHeader("Accept", "application/json");
        setBasicAuth(r);

        var res = r.execute();
        var body = res.getBody();
        try {
            return new global.JSON().decode(body);
        } catch (e) {
            warn("Failed to parse batch results body: " + body);
            return null;
        }
    }

    // ---------------------- PROCESS BATCHES ----------------------

    for (var i = 0; i < batches.length; i++) {
        var batch = batches[i];
        var label = "Batch " + (i + 1) + "/" + batches.length + " (" + batch.length + " app(s))";

        info("====== " + label + " START ======");

        // Log each app in the batch for traceability
        for (var k = 0; k < batch.length; k++) {
            var a = batch[k];
            info("  • " + a.displayName + " | " + a.current_version + " → " + a.requested_version + " | load_demo_data=" + a.load_demo_data + " | id=" + a.id);
        }

        var payload = {
            packages: batch,
            name: "Batch Applications Update via CI/CD - " + ts()
        };

        if (DRY_RUN) {
            info("DRY RUN - Would POST: " + JSON.stringify(payload));
            info("====== " + label + " END (DRY RUN) ======");
            continue;
        }

        // Trigger CI/CD batch install
        var resp;
        try {
            info("Triggering CI/CD batch install...");
            resp = postBatchInstall(payload);
            info("Triggered. Progress ID: " + resp.progressId + (resp.resultsId ? (" | Results ID: " + resp.resultsId) : ""));
        } catch (e1) {
            err("Failed to trigger " + label + ": " + e1);
            info("====== " + label + " END (FAILED TO TRIGGER) ======");
            continue; // move on to next batch
        }

        var completed = false;

        // Poll every 5 min
        for (var p = 1; p <= MAX_POLL_CYCLES; p++) {
            var pr;
            try {
                pr = getProgress(resp.progressId);
            } catch (e2) {
                warn("Progress check error (attempt " + p + "): " + e2);
                gs.sleep(POLL_INTERVAL_MS);
                continue;
            }

            info("Progress " + p + "/" + MAX_POLL_CYCLES +
                " | status=" + pr.status + " (" + pr.status_label + ")" +
                " | percent=" + pr.percent_complete +
                (pr.status_message ? (" | msg=\"" + pr.status_message + "\"") : "") +
                (pr.error ? (" | error=\"" + pr.error + "\"") : ""));

            // "0" Pending, "1" Running, "2" Successful
            if (String(pr.status) === "2" || (pr.status_label && String(pr.status_label).toLowerCase() === "successful")) {
                completed = true;
                break;
            }

            // If unexpected terminal state (rare), break this batch
            if (String(pr.status) !== "0" && String(pr.status) !== "1" && String(pr.status) !== "2") {
                warn(label + " returned unexpected terminal status: " + pr.status + " (" + pr.status_label + ")");
                break;
            }

            gs.sleep(POLL_INTERVAL_MS);
        }

        if (completed) {
            info(label + " completed successfully.");
            if (resp.resultsId) {
                var results = getBatchResults(resp.resultsId);
                if (results) {
                    info("Batch results: " + JSON.stringify(results));
                } else {
                    info("No detailed results returned.");
                }
            }
        } else {
            warn(label + " timed out before completion.");
        }

        info("====== " + label + " END ======");
    }

})();
