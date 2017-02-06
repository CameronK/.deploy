'use strict';
const webpack = require("webpack");
const fs = require('fs-extra');
const path = require('path');
const q = require("q");
const exclude = ['dist', "node_modules", "deploy.js", ".idea", ".git", 'makeMaster.js', 'package.json'];
const exec = require('child_process').exec;

//Main function to execute for the code.
prepareDistFolder().then(copyFiles).then(fixUglify).then(webPackIt).then(gitAddCommit).then(function(results){
    console.log("Success!");
}).catch(function(err){
    console.log("Failed!");
    console.log(JSON.stringify(err));
});

/**
 * webPackIt - Takes the main deploy.js, pulls in all dependencies to one file, and uglifies it for faster operation.
 * @returns {*|promise|h} - Promise returns {success : true} if everything runs properly, or rejects on failure with the error in {error : error}
 */
function webPackIt(){
    var deferred = q.defer();

    var compiler = webpack({
        entry: path.join(__dirname, "deploy.js"),
        errorDetails: true,
        target: 'node',
        output : {
            path : path.join(__dirname, "dist"),
            filename : "deploy.js"
        },
        node: {
            __filename: false,
            __dirname: false
        },
        plugins: [
            new webpack.optimize.UglifyJsPlugin({
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
        },
        resolve : {
            alias : {
                "uglify-js$" : path.join(__dirname, "node_modules", "uglify-js", "tools", "node.js")
            }
        }
    }, function(err, stats) {
        if(err)
            deferred.reject({success: false, error : err});
        var jsonStats = stats.toJson();
        if(jsonStats.errors.length > 0)
            deferred.reject({success: false, error : jsonStats.errors});
        if(jsonStats.warnings.length > 0)
            deferred.resolve({success : true, warnings : jsonStats.warnings});
        deferred.resolve({success : true});
    });

    return deferred.promise;
}

/**
 * copyFiles - Copies all the files besides ".git" needed for the Master branch into the "dist" folder.
 * @returns {*|promise|h} - Resolves on success with a payload of {success : true}, rejects on failure with {success: false, error : error}
 */
function copyFiles(){
    var deferred = q.defer();
    var dist = path.join(__dirname, "dist");
    fs.ensureDir(dist, function (err) {
        if(err){
            deferred.reject({success : false, error : err});
        } else {
            fs.copy(__dirname, dist, function(file){
                for(var i = 0; i < exclude.length; i++){
                    var targetFile = path.normalize(file);
                    var filter = path.join(__dirname, exclude[i]);
                    if(targetFile.startsWith(filter)){
                        return false;
                    }

                }
                return true;
            }, function (err) {
                if (err)
                    deferred.reject({success : false, error : err});
                else {
                    deferred.resolve({success : true});
                }
            })
        }
    })
    return deferred.promise;
}

/**
 * prepareDistFolder - Removes the prior dist folder, recreates it, copies over the .git directory, and sets the branch to "master" before
 * the other operations run, so that everything is ready to go.
 * @returns {*|promise|h} - Resolves to success : "true" with the output of the git command on success, rejects to success : false.
 */
function prepareDistFolder(){
    var deferred = q.defer();
    var dist = path.join(__dirname, "dist");
    fs.removeSync(dist);
    fs.ensureDir(dist, function (err) {
        if(err){
            deferred.reject({success : false, error : err});
        } else {
            fs.copy(path.join(__dirname, ".git"), path.join(dist, ".git"), function (err) {
                if (err)
                    deferred.reject({success : false, error : err});
                else {
                    exec('git stash', {cwd: path.join(__dirname, "dist")}, function(error, stdout, stderr) {
                        if (error) {
                            deferred.reject({success: false, error: error, stdout: stdout, stderr: stderr})
                        } else {
                            exec('git checkout master', {cwd: path.join(__dirname, "dist")}, function (error1, stdout1, stderr1) {
                                if (error) {
                                    deferred.reject({success: false, error: error1, stdout: stdout1, stderr: stderr1})
                                } else {
                                    exec('git pull', {cwd: path.join(__dirname, "dist")}, function (error2, stdout2, stderr2) {
                                        if (error2) {
                                            deferred.reject({success: false, error: error2, stdout: stdout2, stderr: stderr2})
                                        } else {
                                            deferred.resolve({success: true, error: error2, stdout: stdout2, stderr: stderr2})
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            })
        }
    })
    return deferred.promise;
}

/**
 * gitAddCommit - Adds all files that changed from the master that are in the dist folder, commits, and pushes these changes.
 * @returns {*|promise|h} - Resolves to success : true on success, or rejects to success : false. Also contains output of commands.
 */
function gitAddCommit(){
    var deferred = q.defer();
    exec('git add .', {cwd: path.join(__dirname, "dist")}, function(error, stdout, stderr){
        if (error) {
            deferred.reject({success : false, error : error, stdout: stdout, stderr : stderr })
        } else {
            exec('git commit --message="Build Master:' + new Date().toISOString() + '"',
                {cwd: path.join(__dirname, "dist")}, function(error2, stdout2, stderr2){
                    if (error2) {
                        deferred.reject({success : false, error : error2, stdout: stdout2, stderr : stderr2 })
                    } else {
                        exec('git push', {cwd: path.join(__dirname, "dist")}, function(error3, stdout3, stderr3){
                            if (error3) {
                                deferred.reject({success : false, error : error3, stdout: stdout3, stderr : stderr3 })
                            } else {
                                deferred.resolve({success : true, error : error3, stdout: stdout3, stderr : stderr3 })
                            }
                        });
                    }
                });
        }
    });
    return deferred.promise;
}

/**
 * fixUglify - Self-Uglifies since doing this the normal way with WebPack fails. Webpack config does the substitute.
 * @returns {*|promise|f} - Resolves if successful, rejects if fails.
 */
function fixUglify(){
    var deferred = q.defer();
    var uglifyPath = path.join(__dirname, "node_modules", "uglify-js" );

    if(fs.existsSync(path.join(uglifyPath, "uglify.js"))){
        deferred.resolve({success: true, action: "Already uglified", message: "Already uglified!"});
    } else {
        //Generate Self-Uglified Uglify JS.
        exec('node bin/uglifyjs --self -c -o uglify.js', {cwd: uglifyPath }, function(error, stdout, stderr) {
            if(error){
                deferred.reject({success: false, action: "Self-uglify", error: error, stdout: stdout, stderr: stderr});
            } else {
                deferred.resolve({success: true, action: "Self-uglify", message : "Complete!"});
            }
        });
    }
    return deferred.promise;
}