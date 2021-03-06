var Parent = require('vfs-child').Parent;
var fs = require('fs');

var child = new Parent({root:__dirname + "/"});

child.on("connect", function () {
    console.log(process.pid, "the socket connected");
});

child.on("disconnect", function (err) {
    console.error(process.pid, "The socket disconnected", err);
    if (err) throw err;
});

child.connect(function (err, vfs) {
    if (err) throw err;

    console.log(process.pid, "CONNECTED");

    // Extend the API
    var options = {
        names: ["add", "multiply"]
    };

    console.log(process.pid, "Calling extend");
    vfs.extend("math", options, onExtend);

    // Test the extension
    function onExtend(err, meta) {
        if (err) throw err;
                file:
        console.log("Sending code to child for extension");
        fs.createReadStream(__dirname + "/extension.js").pipe(meta.stream);
        var math = meta.api;
        math.on("ready", function () {
            console.log("Calling add(3, 5, callback)");
            math.add(3, 5, function (err, result) {
                if (err) throw err;
                console.log("3 + 5 = %s", result);
            });
        });
    }

});

