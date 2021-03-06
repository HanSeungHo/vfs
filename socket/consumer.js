var Stream = require('stream').Stream;
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var Agent = require('smith').Agent;

exports.Consumer = Consumer;

function Consumer() {

    Agent.call(this, {
        onExit: onExit,
        onData: onData,
        onEnd: onEnd,
        onClose: onClose,
        onChange: onChange,
        onReady: onReady,
        onEvent: onEvent
    });

    var proxyStreams = {}; // Stream proxies given us by the other side
    var proxyProcesses = {}; // Process proxies given us by the other side
    var proxyWatchers = {}; // Watcher proxies given us by the other side
    var proxyApis = {};
    var handlers = {}; // local handlers for remote events
    var pendingOn = {}; // queue for pending on handlers.
    var pendingOff = {}; // queue for pending off handlers.

    this.vfs = {
        ping: ping, // Send a simple ping request to the worker
        spawn: route("spawn"),
        exec: route("exec"),
        connect: route("connect"),
        readfile: route("readfile"),
        mkfile: route("mkfile"),
        rmfile: route("rmfile"),
        readdir: route("readdir"),
        stat: route("stat"),
        mkdir: route("mkdir"),
        rmdir: route("rmdir"),
        rename: route("rename"),
        copy: route("copy"),
        symlink: route("symlink"),
        watch: route("watch"),
        changedSince: route("changedSince"),
        extend: route("extend"),
        emit: emit,
        on: on,
        off: off
    };
    var remote = this.remoteApi;

    // Forward drain events to all the writable streams.
    this.on("drain", function () {
        Object.keys(proxyStreams).forEach(function (id) {
            var stream = proxyStreams[id];
            if (stream.writable) stream.emit("drain");
        });
    });

    // options.id, options.readable, options.writable
    function makeStreamProxy(token) {
        var stream = new Stream();
        var id = token.id;
        stream.id = id;
        proxyStreams[id] = stream;
        if (token.hasOwnProperty("readable")) stream.readable = token.readable;
        if (token.hasOwnProperty("writable")) stream.writable = token.writable;

        if (stream.writable) {
            stream.write = function (chunk) {
                return remote.write(id, chunk);
            };
            stream.end = function (chunk) {
                if (chunk) remote.end(id, chunk);
                else remote.end(id);
            };
        }
        if (stream.readable) {
            stream.destroy = function () {
                remote.destroy(id);
            };
        }

        return stream;
    }
    function makeProcessProxy(token) {
        var process = new EventEmitter();
        var pid = token.pid;
        process.pid = pid;
        proxyProcesses[pid] = process;
        process.stdout = makeStreamProxy(token.stdout);
        process.stderr = makeStreamProxy(token.stderr);
        process.stdin = makeStreamProxy(token.stdin);
        process.kill = function (signal) {
            remote.kill(pid, signal);
        };
        return process;
    }

    function makeWatcherProxy(token) {
        var watcher = new EventEmitter();
        var id = token.id;
        watcher.id = id;
        proxyWatchers[id] = watcher;
        watcher.close = function () {
            remote.close(id);
            delete proxyWatchers[id];
        };
        return watcher;
    }

    function makeApiProxy(token) {
        var name = token.name;
        var api = proxyApis[name] = new EventEmitter();
        token.names.forEach(function (functionName) {
            api[functionName] = function () {
                remote.call(name, functionName, Array.prototype.slice.call(arguments));
            };
        });
        return api;
    }

    function onExit(pid, code, signal) {
        var process = proxyProcesses[pid];
        process.emit("exit", code, signal);
        delete proxyProcesses[pid];
        delete proxyStreams[process.stdout.id];
        delete proxyStreams[process.stderr.id];
        delete proxyStreams[process.stdin.id];
    }
    function onData(id, chunk) {
        var stream = proxyStreams[id];
        stream.emit("data", chunk);
    }
    function onEnd(id) {
        var stream = proxyStreams[id];
        stream.emit("end");
        delete proxyStreams[id];
    }
    function onClose(id) {
        var stream = proxyStreams[id];
        if (!stream) return;
        stream.emit("close");
        delete proxyStreams[id];
    }

    function onChange(id, event, filename) {
        var watcher = proxyWatchers[id];
        if (!watcher) return;
        watcher.emit("change", event, filename);
    }

    function onReady(name) {
        var api = proxyApis[name];
        if (!api) return;
        api.emit("ready");
    }

    // For routing events from remote vfs to local listeners.
    function onEvent(name, value) {
        var list = handlers[name];
        if (!list) return;
        for (var i = 0, l = list.length; i < l; i++) {
            list[i](value);
        }
    }

    function on(name, handler, callback) {
        if (handlers[name]) {
            handlers[name].push(handler);
            if (pendingOn[name]) {
                callback && pendingOn[name].push(callback);
                return;
            }
            return callback();
        }
        handlers[name] = [handler];
        var pending = pendingOn[name] = [];
        callback && pending.push(callback);
        return remote.subscribe(name, function (err) {
            for (var i = 0, l = pending.length; i < l; i++) {
                pending[i](err);
            }
            delete pendingOn[name];
        });
    }

    function off(name, handler, callback) {
        if (pendingOff[name]) {
            callback && pendingOff[name].push(callback);
            return;
        }
        if (!handlers[name]) {
            return callback();
        }
        var pending = pendingOff[name] = [];
        callback && pending.push(callback);
        return remote.unsubscribe(name, function (err) {
            delete handlers[name];
            for (var i = 0, l = pending.length; i < l; i++) {
                pending[i](err);
            }
            delete pendingOff[name];
        });
    }

    function emit() {
        remote.emit.apply(this, arguments);
    }

    // Return fake endpoints in the initial return till we have the real ones.
    function route(name) {
        return function (path, options, callback) {
            if (!callback) throw new Error("Forgot to pass in callback for " + name);
            return remote[name].call(this, path, options, function (err, meta) {
                if (err) return callback(err);
                if (meta.stream) {
                    meta.stream = makeStreamProxy(meta.stream);
                }
                if (meta.process) {
                    meta.process = makeProcessProxy(meta.process);
                }
                if (meta.watcher) {
                    meta.watcher = makeWatcherProxy(meta.watcher);
                }
                if (meta.api) {
                    meta.api = makeApiProxy(meta.api);
                }

                return callback(null, meta);
            });
        };
    }
    function ping(callback) {
        return remote.ping(callback);
    }


}
inherits(Consumer, Agent);

// Emit the wrapped API, not the raw one
Consumer.prototype._emitConnect = function () {
    this.emit("connect", this.vfs);
};

