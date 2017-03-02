'use strict';
const path = require('path');
const fs = require('fs-extra');
const q = require('q');
require('dotenv').config({path: path.join(process.env.DEPLOYMENT_SOURCE, '.deployment') });

//******************** EXPORTED **********************************************
module.exports.createDistribution = function(webPackLib){
    console.log("Start: createDistribution");
    var deferred = q.defer();
    var creationResults = [];
    checkEnvVariables();
    console.log("Clearing Dist Directory");
    fs.emptyDirSync(path.join(process.env.DEPLOYMENT_SOURCE, process.env.DEPLOY_DIST_FOLDER));
    console.log("Dist Directory is clear");
    getFunctionFolders().then(function(results){
        var top_folders = results.top_folders;
        for(var x = 0; x < top_folders.length; x++){
            console.log("Start Folder:", top_folders[x]);
            creationResults.push(catalogDependencyFiles(top_folders[x]));
        }
        q.allSettled(creationResults).then(createDependencyFileJS).then(createDependencyFile).then(function(output){
            webPackIt(webPackLib).then(
                function(results){
                    var exclude = Array.from(new Set(output.indexes.concat(results.webpackedFiles)));
                    copyDist(exclude).then(function(results){
                        deferred.resolve(results);
                    }, function(error){
                        deferred.reject({success: false, action: "copyDist", error: error});
                    })

                }).catch(function(error){
                    deferred.reject({success: false, action: "webPackIt", error: error});
                });
        });
    });
    return deferred.promise;
}

function webPackIt(webPackLib){
    const deferred = q.defer();
    const outputDir = path.join(process.env.DEPLOYMENT_SOURCE, process.env.DEPLOY_DIST_FOLDER);
    console.log("Running Webpack...");
    var compiler = webPackLib({
        entry: path.join(process.env.DEPLOYMENT_SOURCE, process.env.WEBPACK_OUTPUT_FILE),
        target: 'node',
        output : {
            path : path.join(process.env.DEPLOYMENT_SOURCE, process.env.DEPLOY_DIST_FOLDER),
            filename : process.env.WEBPACK_OUTPUT_FILE,
            library: "index",
            libraryTarget: "commonjs2"
        },
        node: {
            __filename: false,
            __dirname: false
        },
        plugins: [
            new webPackLib.optimize.UglifyJsPlugin({
                compress: {
                    warnings: false,
                },
                output: {
                    comments: false,
                }
            })
        ],
        module: {
            loaders: [{
                test: /\.json$/,
                loader: 'json-loader'
            }]
        }
    }, function(err, stats) {
        //Delete the temp file once created
        try {
            //fs.unlinkSync(path.join(base, folder, process.env.WEBPACK_OUTPUT_FILE));
        } catch (error){
            if(error.code !== "ENOENT")
                err = error;
        }
        if(err){
            console.log("Full Error");
            console.log(JSON.stringify(err));
            deferred.reject({success: false, error : err});
        }
        var jsonStats = stats.toJson();
        if(jsonStats.errors.length > 0){
            console.log("JSonStats:")
            console.log(JSON.stringify(jsonStats));
            deferred.reject({success: false, error : jsonStats.errors});
        }
        const webpackedFiles = jsonStats.modules.reduce(function(acc, module){
            if(module.identifier.indexOf(path.sep) >=0 && module.identifier.indexOf("node_modules") < 0)
                acc.push(module.identifier);
            return acc;
        }, []);

        if(jsonStats.warnings.length > 0)
            deferred.resolve({success : true, warnings : jsonStats.warnings, webpackedFiles: webpackedFiles});
        deferred.resolve({success : true, webpackedFiles: webpackedFiles});
    });

    return deferred.promise;
}

function getFoldersToCopy(excludeFiles){
    console.log("Start getFoldersToCopy");
    const deferred = q.defer();
    const excludeFolders = JSON.parse(process.env.DEPLOY_EXCLUDE_FOLDERS);

    walk(process.env.DEPLOYMENT_SOURCE, function(err, results){
       if(err)
           deferred.reject({success : false, action: "getFoldersToCopy", error: err});
       else
           deferred.resolve(results);
    });

    function walk(dir, done) {
        var results = {};
        fs.readdir(dir, function(err, list) {
            if (err) return done(err);
            var pending = list.length;
            if (!pending) return done(null, results);
            list.forEach(function(file) {
                //If its an excluded folder or file, skip it.
                if(excludeFolders.indexOf(file) >= 0 || excludeFiles.indexOf(path.resolve(dir, file)) >= 0){
                    if (!--pending) done(null, results);
                    return;
                }

                file = path.resolve(dir, file);
                fs.stat(file, function(err, stat) {
                    if (stat && stat.isDirectory()) {
                        walk(file, function(err, res) {
                            results = Object.assign(results, res);
                            if (!--pending) done(err, results);
                        });
                    } else {
                        results[dir] = (results[dir]) ? results[dir] : [];
                        results[dir].push(file);
                        if (!--pending) done(null, results);
                    }
                });
            });
        });
    };

    return deferred.promise;
}



function copyDist(excludeFiles){
    console.log("Start copyFiles");
    var promiseCopy = q.denodeify(fs.copy);
    var deferred = q.defer();
    getFoldersToCopy(excludeFiles).then(function(results){
        const fromDir = process.env.DEPLOYMENT_SOURCE;
        const toDir = path.join(process.env.DEPLOYMENT_SOURCE, process.env.DEPLOY_DIST_FOLDER);

        for (var folder in results) {
            if (!results.hasOwnProperty(folder)) continue;


            var promises = [];
            results[folder].forEach(function(file) {
                //Files that remain if included by JavaScript will be included relative to the new JavaScript file in the base,
                //Rather than in their original location. As a result, besides special files, we want to move any remaining files to the base.
                var destination = (folder.replace(fromDir, '') === "" || /function\.json/i.test(file)) ?
                    file.replace(fromDir, toDir) : path.join(toDir, file.replace(fromDir, "").split(path.sep).splice(2).join(path.sep));
               // console.log("File:" + file + " Destination:" + destination);
                promises.push(promiseCopy(file, destination));
            });

            q.all(promises).then(function(results) {
                deferred.resolve(true);
            });
        }
    });

    return deferred.promise;
}

function checkEnvVariables(){
    console.log("Validating and Defaulting ENV variables.");
    process.env.WEBPACK_OUTPUT_FILE = (process.env.WEBPACK_OUTPUT_FILE) ? process.env.WEBPACK_OUTPUT_FILE : "azure.deps.js";
    process.env.DEPLOY_DIST_FOLDER = (process.env.DEPLOY_DIST_FOLDER) ? process.env.DEPLOY_DIST_FOLDER : "dist";

    try{
        var t = JSON.parse(process.env.DEPLOY_EXCLUDE_FOLDERS);
        if(t.length < 1)
            throw new Error("Default Not Set");
    } catch(exception){
        console.log("WARNING: DEPLOY_EXCLUDE_FOLDERS is not set, or not set to an array. Values defaulted.");
        console.log('Enter a proper value in .deployment or as an ENV variable. e.g. [".git", ".deploy", ".idea", "node_modules", "dist", "package.json", ".deployment", ".gitignore", ".gitmodules", ".npmignore"]');
        process.env.DEPLOY_EXCLUDE_FOLDERS = '[".git", ".deploy", ".idea", "node_modules", "' + process.env.DEPLOY_DIST_FOLDER + '", "package.json", ".deployment", ".gitignore", ".gitmodules", ".npmignore"]';
    }
}


/**
 * getFunctionFolders - Gets a list of all the folders that contain functions.
 * @returns {*|promise|h|*|promise|h}
 */
function getFunctionFolders(){
    console.log("Start getFunctionFolders");
    var deferred = q.defer();
    var topFolders = [];
    fs.readdir(process.env.DEPLOYMENT_SOURCE, function(err,files){
        if(err){
            deferred.reject({success : false, error : err});
        } else {
            var exclude_files = JSON.parse(process.env.DEPLOY_EXCLUDE_FOLDERS);
            for(var i=0; i<files.length; i++){
                if( exclude_files.indexOf(files[i]) < 0 && fs.statSync(path.join(process.env.DEPLOYMENT_SOURCE, files[i])).isDirectory()) {
                    topFolders.push(files[i]);
                }
            }
            deferred.resolve({success : true, top_folders : topFolders });
        }
    });
    return deferred.promise;
}

function catalogDependencyFiles(folder){
    console.log("Start catalogDependencyFiles");
    const deferred = q.defer();
    const base = process.env.DEPLOYMENT_SOURCE;
    const index = path.join(base, folder, "index.js");

    fs.readFile(index, 'utf8', function (err,data) {
        if (err && err.code == 'ENOENT')
            deferred.reject({success : true, error : err });
        else if (err)
            deferred.reject({success : false, error : err });

        getPaths(index, data).then(resolvePaths).then(updateIndex).then(function(results){
            deferred.resolve({success:true, results : results});
        }).done(function(){}, function(error){
            deferred.reject({success: false, "action":"createDependencyDone", "error": error });
        });
    });

    return deferred.promise;
}


//*********************** HELPER FUNCTIONS ***************************

/**
 * getPaths - Give a file name, extracts all requires with path.join's that include variables.
 * @param file - The name of the file to search
 * @returns {*|promise|h|} - Object { FILE_PATTERN : {find : REQUIRE_STATEMENT, files: []}}
 */
function getPaths(file, data){
    var deferred = q.defer();
    var paths = {};
    const replace = {
        "__dirname" : "'" + path.dirname(file) + "'"
    };

    //Extract the normal requires without wildcards.
    var regex = /require\s*\(['"]([^'"]+)['"]\)/g;
    var match = regex.exec(data);

    //Grab/Store all standard libraries to remove duplicates
    while (match !== null) {
        var requireName = (match[1].search(/^[\.]+[\\\/]/) < 0) ? path.normalize(match[1]) : path.normalize(path.join(path.dirname(file), match[1]));
        paths[requireName] = {}
        paths[requireName].find =match[0];
        paths[requireName].files = [match[1]];
        paths[requireName].replace = "'" + requireName.replace(path.normalize(process.env.DEPLOYMENT_SOURCE) + path.sep,'') + "'";
        match = regex.exec(data);
    }

    //Extract the WildCard requires
    var regexPathRequire = /require\s*\(\s*\(*\s*path\.join\s*\(([^\)]+)\)\s*\)*\s*\)/g
    var matchPathRequire = regexPathRequire.exec(data);

    while (matchPathRequire !== null) {
        var wildCardName = matchPathRequire[1].split(",").map(function (value) {
            //Make replacements for known variables
            var updated = (replace[value]) ? value.replace(value, replace[value]).trim() : value.trim();

            var varReplaced = updated.split("+").map(function (section) {
                if (/^'.+'$/.test(section.trim())) //If surrounded by ', its a String so return value with ' trimmed
                    return section.trim().replace(/^'/, '').replace(/'$/, '');
                if (/^".+"$/.test(section.trim())) //If surrounded by ", its a String so return value with " trimmed
                    return section.trim().replace(/^"/, '').replace(/"$/, '');
                //If not, its a var, so return a wildcard.
                return "*";
            }).join('');

            return varReplaced;
        }).join(path.sep);
        wildCardName = path.normalize(wildCardName);
        paths[wildCardName] = {};
        paths[wildCardName].find = matchPathRequire[0];

        var notPath = (path.sep === "\\") ? /\//g : /\\/g;
        //Used to remove __dirname since later reference remove the baseDir from the naming
        var replaceValue = matchPathRequire[1].replace(/__dirname/g, "'" + path.dirname(file) + "'").split(/\s*,\s*/g).reduce(reduceStrings, path.sep);
        replaceValue = replaceValue.split(/\s*\+\s*/g).reduce(reduceStrings, "+").replace(notPath, path.sep).replace(path.sep + path.sep, path.sep);

        paths[wildCardName].replace = replaceValue.replace(path.normalize(process.env.DEPLOYMENT_SOURCE) + path.sep,'');
        //Tack on . JS at the end, if not .js or .json since wild-cards get evaluated to absolute files need it to match.
        paths[wildCardName].replace = (/\.js(on)*['"]/i.test(paths[wildCardName].replace)) ? paths[wildCardName].replace : paths[wildCardName].replace + " + '.js'";
        paths[wildCardName].files = [];
        matchPathRequire = regexPathRequire.exec(data);
    }
    deferred.resolve({success: true, index: file, paths :paths });

    return deferred.promise;
}

function reduceStrings(acc, curr, index, array){
    var qRegex = /'[^']+'/;
    var dqRegex = /"[^"]+"/;
    var begRegex = /^['"]/;
    var endRegex = /['"]$/;
    var sep = acc[0];
    var retVal = '';
    //If both the accumulated & Current value are strings, concat them
    if(qRegex.test(acc) && endRegex.test(acc) && begRegex.test(curr) &&  (qRegex.test(curr) || dqRegex.test(curr))   ) {
         retVal = acc.replace(begRegex, "'").replace(endRegex, '') + sep + curr.replace(begRegex, '').replace(endRegex, "'");
    } else if (endRegex.test(acc)){//If acc is a string, need the sep to be within the quotes, not after.
        var tempSep = (sep === '+') ? "'" + sep : sep + "' + ";//If next item starts with a non-string, we need a + if this is a / call
        retVal = acc.replace(endRegex, tempSep) + curr.replace(/"/g, "'");
    } else {
        retVal = acc + sep + curr;
    }
    retVal = (index + 1 === array.length) ? retVal.slice(2) : retVal;
    return retVal;
}

/**
 * resolvePaths - Takes a list of wildcard patterns and gets files that match that patterns.
 * @param wildCardPaths - Object of the format that getPaths returns e.g.  - Object { FILE_PATTERN : {find : REQUIRE_STATEMENT, files: []}}
 * @returns {*|promise|h} - Object { FILE_PATTERN : {find : REQUIRE_STATEMENT, files: [FILE_MATCH1, FILE_MATCH2]}} with files filled out
 */
function resolvePaths(pathResults){
    var deferred = q.defer();
    var promises = [];
    var paths = pathResults.paths;
    for (var filePath in paths) {
        if (!paths.hasOwnProperty(filePath)) continue;

        //If it doesn't have a / or \ its a node_module and should not go through this process
        if(filePath.search(/[\\\/]/) < 0)
            continue;

        var normalPath = path.normalize(filePath);

        var baseDir ="",
            basePath = "";

        //If its something that references a file-path, do something else.
        if (normalPath.indexOf("*") < 0){
            baseDir = path.dirname(normalPath);
            basePath = path.basename(normalPath);
        } else {
            basePath = normalPath.substr(0, normalPath.indexOf("*"));
            baseDir = basePath.substr(0, basePath.lastIndexOf(path.sep));
        }
        promises[promises.length] = paths[filePath].filePromise = getFiles(baseDir, normalPath);
    }
    q.allSettled(promises).then(function(results){
        for (var filePath in paths) {
            if (!paths.hasOwnProperty(filePath)) continue;
            if(paths[filePath].filePromise) {//Since nonWildCard hasn't set this
                paths[filePath].files = paths[filePath].filePromise.valueOf();
                delete paths[filePath].filePromise;
            }
        }
        deferred.resolve({success: true, action: "resolvePaths", index: pathResults.index, paths: paths });
    }).catch(function(error){
        deferred.reject({ success : false, action: "resolvePaths", error: error });
    });
    return deferred.promise;
}

/**
 * getFiles - Searches the given base directory for items that match the filePattern.
 * @param baseDir - The base directory to search e.g. c:\dev\src
 * @param filePattern - A file pattern with * for wildcards
 * @returns {*|promise|h} - Array of File matches on resolve [FILE_ONE, FILE_TWO], detailed error object on reject
 */
function getFiles(baseDir, filePattern){
    const deferred = q.defer();

    //If there are no wildcards in the filePattern then check-exist & resolve to values
    if(filePattern.indexOf("*") < 0) {
        fs.stat(filePattern, function (err, stats) {
            //If an error and has a file extension, resolve with no files.
            if (err && path.extname(filePattern) !== '')
                deferred.resolve([]);
            else if (err) { //Otherwise, if just error, retry with ".js".
                fs.stat(filePattern + ".js", function (error, stats) {
                   deferred.resolve((error) ? [] : filePattern + ".js");
                });
            } else {//Otherwise if not an error, resolve to files
                if (stats.isDirectory()) {//If directory, we really want index.js
                    fs.stat(path.join(filePattern, "index.js"), function (error, stats) {
                        deferred.resolve((error) ? [] : [path.join(filePattern, "index.js")]);
                    });
                } else //Not a directory, so this is a valid value and can be returned
                    deferred.resolve([filePattern]);
            }
        });
    } else { //If wild-cards, follow the file path to resolve.
        walk(baseDir, filePattern, function(err, files){
            if(err)
                deferred.reject({success: false, action: "getFiles", dir : baseDir, pattern: filePattern, files: files, error : err });
            else{
                deferred.resolve(files);
            }
        });
    }

    function walk(dir, fileFilter, done) {
        var results = [];
        fs.readdir(dir, function(err, list) {
            if (err) return done(err);
            var pending = list.length;
            if (!pending) return done(null, results);
            list.forEach(function(file) {
                file = path.resolve(dir, file);
                fs.stat(file, function(err, stat) {
                    if (stat && stat.isDirectory()) {
                        if(matchesFilePattern(file, fileFilter, true))
                            walk(file, fileFilter, function(err, res) {
                                results = results.concat(res);
                                if (!--pending) done(null, results);
                            });
                        else
                        if (!--pending) done(null, results);
                    } else {
                        if(matchesFilePattern(file, fileFilter, false))
                            results.push(file);
                        if (!--pending) done(null, results);
                    }
                });
            });
        });
    };
    return deferred.promise;
}

/**
 * matchesFilePattern - Helper function for getFiles that tests to see if a given file matches the described pattern
 * @param file - The file to see if it matches.
 * @param pattern - The pattern to match
 * @param isDir - Is it a directory? If so then a subdir of a valid path is also valid (so getFiles will recures properly)
 * @returns {boolean} - True if it matches the file pattern, false if it does not.
 */
function matchesFilePattern(file, pattern, isDir){
    var patterns = pattern.split("*");
    var toMatch = file;
    for(var i=0; i<patterns.length; i++){
        switch(i){
            case (patterns.length - 1):
                //If the pattern matches return true, or if there are no more slashes then the wildcard would have covered i
                if(toMatch.endsWith(patterns[i]) || ((toMatch.match(new RegExp("\\" + path.sep, "g")) || []).length < 2))
                    return true;
                else
                    return false;
            case 0:
                if(!toMatch.startsWith(patterns[i]))
                    return false;
                toMatch = toMatch.replace(patterns[i],'');
                break;
            default:
                var index = toMatch.indexOf(patterns[i]);
                //If its a file, it needs to match 100%
                if( index < 0 && !isDir)
                    return false;
                if( index < 0 && isDir){//If its a dir, this could still be a match
                    //Find the last slash and take before that as a pattern
                    var p = patterns[i].substr(0,patterns[i].lastIndexOf(path.sep));
                    if(p === "")//If there isn't a slash, & a dir, this would be covered by last wildcard.
                        return true;
                    var m = toMatch.indexOf(p);
                    if(m < 0) //If there is no match to this pattern, its definitely false
                        return false;
                    //If there is a match, and when you find the index of that match there is nothing left toMatch
                    //Then this dir is still potentially in scope.
                    if(m >= 0 && toMatch.substr(m + p.length).trim().length < 1)
                        return true
                    else //If not, return false
                        return false;
                }
                if(index >= 0){
                    toMatch = toMatch.substr(index + patterns[i].length);
                }
        }
    }
}

/**
 * createDependencyFileJS  - Takes the wildCardPaths output from resolvePaths and generates the JavaScript to include/reference files
 * @param wildCardPaths - Output format from resolvePaths - e.g. Object { FILE_PATTERN : {find : REQUIRE_STATEMENT, files: [FILE_MATCH1, FILE_MATCH2]}}
 * @returns {*|promise|h} - String - The JavaScript to create the includes.
 */
function createDependencyFileJS(allResults){
    console.log("start CreateDependencyFileJS");
    var deferred = q.defer();
    var requires = "\tglobal.azureDeps = (global.azureDeps) ? global.azureDeps : {};\n";
    var indexes = [];
    var alreadySet = {};
    allResults.forEach(function callback(promise, pr, prArray) {
        indexes.push(promise.value.results.index);
        var paths = promise.value.results.paths;
        Object.keys(paths).forEach(function(aPath, pa, paArray){
            paths[aPath].files.forEach(function(file, fi, fiArray){
                if(!alreadySet[file]) {
                    var replaceValue = file.replace(path.normalize(process.env.DEPLOYMENT_SOURCE) + path.sep,'');
                    requires += '\tglobal.azureDeps["' + replaceValue.replace(/[\\]/g, '\\$&') +
                        '"] =\trequire("' + file.replace(/[\\]/g, '\\$&') + '");\n';
                    if (path.extname(replaceValue).toLowerCase() === '.js') {//Add aliases for other common ways referenced
                        if(path.basename(replaceValue, '.js') === 'index')//If index, also reference just by the dirname
                            requires += '\tglobal.azureDeps["' + path.dirname(replaceValue).replace(/[\\]/g, '\\$&') +
                                '"] =\t global.azureDeps["' + replaceValue.replace(/[\\]/g, '\\$&') + '"];\n';
                        else {//If non-index, also reference by the dir + basename without the .js extension
                            requires += '\tglobal.azureDeps["' + path.join(path.dirname(replaceValue), path.basename(replaceValue, '.js')).replace(/[\\]/g, '\\$&') +
                                '"] =\t global.azureDeps["' + replaceValue.replace(/[\\]/g, '\\$&') + '"];\n';
                        }
                    }
                    alreadySet[file] = true;
                }
                if(pr + 1 === prArray.length && pa + 1 === paArray.length && fi + 1 === fiArray.length )
                    deferred.resolve({success : true, action: "createDependencyFileJS", js : requires, indexes: indexes })
            });
        });
    })

    return deferred.promise;
}

function createDependencyFile(results){
    console.log("Start createDependencyFile");
    var deferred = q.defer();
    var depFile = path.join(process.env.DEPLOYMENT_SOURCE, process.env.WEBPACK_OUTPUT_FILE);

    fs.writeFile(depFile, results.js, function(err) {
        if (err)
            deferred.reject({success: false, action: "Write Dep File", file: depFile, error: err});
        else
            deferred.resolve({success : true, indexes: results.indexes });
    });
    return deferred.promise;
}

/**
 * updateIndex - Updates the copied index to point to the appropriate requiered files.
 * @param folder - The folder to get the index from
 * @returns {*|promise|h|*|promise|h} - Resolve on Success Reject on Failure
 */
function updateIndex(pathResults){
    console.log("Start updateIndex");
    const deferred = q.defer();
    const index = pathResults.index;
    const newIndex = pathResults.index.split(path.sep).slice(0,-2).concat([process.env.DEPLOY_DIST_FOLDER], pathResults.index.split(path.sep).slice(-2)).join(path.sep);
    const depFile = path.join(path.dirname(pathResults.index), process.env.WEBPACK_OUTPUT_FILE);

    //Read tye copied index file and start creating the new file.
    fs.readFile(index, 'utf8', function (err,data) {
        if (err)
            deferred.reject({success : false, error : err });

        //Update data to reference the new dependency structure
        for (var filePath in pathResults.paths) {
            if (!pathResults.paths.hasOwnProperty(filePath)) continue;
            var pathObj = pathResults.paths[filePath];
            //Escape the string, and then substitute regExPattern for ' or " to allow either to surround string
            var sReg = pathObj.find.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/['"]/g,"['\"]");
            data = data.replace(new RegExp(sReg, "g"), "global.azureDeps[" + pathObj.replace.replace(/[\\]/g, '\\$&') + "]");

        }

        //Add Require Dependency to top of the file.
        var useStrictRegex = /^\s*['"]use strict['"];/g;
        var useStrict = "'use strict';\n";
        var requireFile = "require('" + path.join(process.env.DEPLOYMENT_TARGET, process.env.WEBPACK_OUTPUT_FILE).replace(/[\\]/g, '\\$&') + "');\n";
        data = (useStrictRegex.test(data)) ? data.replace(useStrictRegex, useStrict + requireFile) : requireFile + data;

        //Write the new index file with the contents
        fs.ensureDir(path.dirname(newIndex), function(err){
            if (err)
                deferred.reject({success : false, "action": "UpdateIndex-ensureDir", "index" : newIndex, error : err });
            fs.writeFile(newIndex, data, function(error){
                if (error)
                    deferred.reject({success : false, "action": "UpdateIndex-writeIndex", "index" : newIndex, error : error });
                deferred.resolve({success : true, index: pathResults.index, paths: pathResults.paths, newIndex: newIndex });
            });
        });

    });
    return deferred.promise;
}