Array.prototype.shift8 = function () {
    return this.shift();
}
Array.prototype.push8 = function (num) {
    this.push(num & 0xFF);
}

Array.prototype.shift16 = function () {
    return (this.shift() << 8) +
           (this.shift()     );
}
Array.prototype.push16 = function (num) {
    this.push((num >> 8) & 0xFF,
              (num     ) & 0xFF  );
}


Array.prototype.shift32 = function () {
    return (this.shift() << 24) +
           (this.shift() << 16) +
           (this.shift() <<  8) +
           (this.shift()      );
}
Array.prototype.push32 = function (num) {
    this.push((num >> 24) & 0xFF,
              (num >> 16) & 0xFF,
              (num >>  8) & 0xFF,
              (num      ) & 0xFF  );
}

Array.prototype.shiftStr = function (len) {
    var arr = this.splice(0, len);
    return arr.map(function (num) {
            return String.fromCharCode(num); } ).join('');
}

Array.prototype.shiftBytes = function (len) {
    return this.splice(0, len);
}

/*
 * Pending frame buffer update data
 */
var FBU = {
    rects    : 0,
    subrects : 0,
    tiles    : 0,
    bytes    : 0,
    x        : 0,
    y        : 0,
    width    : 0, 
    height   : 0,
    encoding : 0,
    subencoding : -1,
    background: null,
    arr      : null};


/*
 * RFB namespace
 */

RFB = {

ws        : null,  // Web Socket object

version   : "RFB 003.003\n",
state     : 'ProtocolVersion',
shared    : 1,
poll_rate : 1413,

host      : '',
port      : 5900,
password  : '',

fb_width  : 0,
fb_height : 0,
fb_name   : "",
fb_Bpp    : 4,
rre_chunk : 100,


/*
 * Server message handlers
 */

/* RFB/VNC initialisation */
init_msg: function (data) {
    console.log(">> init_msg: " + RFB.state);

    switch (RFB.state) {

    case 'ProtocolVersion' :
        if (data.length != 12) {
            console.log("Invalid protocol version from server");
            RFB.state = 'reset';
            return;
        }
        console.log("Server  ProtocolVersion: " + data.shiftStr(11));
        console.log("Sending ProtocolVersion: " + RFB.version.substr(0,11));
        RFB.send_string(RFB.version);
        RFB.state = 'Authentication';
        break;

    case 'Authentication' :
        if (data.length < 4) {
            console.log("Invalid auth frame");
            RFB.state = 'reset';
            return;
        }
        var scheme = data.shift32();
        console.log("Auth scheme: " + scheme);
        switch (scheme) {
            case 0:  // connection failed
                var strlen = data.shift32();
                var reason = data.shiftStr(strlen);
                console.log("auth failed: " + reason);
                RFB.state = "failed";
                return;
            case 1:  // no authentication
                RFB.send_array([RFB.shared]); // ClientInitialisation
                RFB.state = "ServerInitialisation";
                break;
            case 2:  // VNC authentication
                var challenge = data.shiftBytes(16);
                console.log("Password: " + RFB.password);
                console.log("Challenge: " + challenge + "(" + challenge.length + ")");
                passwd = RFB.passwdTwiddle(RFB.password);
                //console.log("passwd: " + passwd + "(" + passwd.length + ")");
                response = des(passwd, challenge, 1);
                //console.log("reponse: " + response + "(" + response.length + ")");

                RFB.send_array(response);
                RFB.state = "SecurityResult";
                break;
        }
        break;

    case 'SecurityResult' :
        if (data.length != 4) {
            console.log("Invalid server auth response");
            RFB.state = 'reset';
            return;
        }
        var resp = data.shift32();
        switch (resp) {
            case 0:  // OK
                console.log("Authentication OK");
                break;
            case 1:  // failed
                console.log("Authentication failed");
                RFB.state = "reset";
                return;
            case 2:  // too-many
                console.log("Too many authentication attempts");
                RFB.state = "failed";
                return;
        }
        RFB.send_array([RFB.shared]); // ClientInitialisation
        RFB.state = "ServerInitialisation";
        break;

    case 'ServerInitialisation' :
        if (data.length < 24) {
            console.log("Invalid server initialisation");
            RFB.state = 'reset';
            return;
        }

        /* Screen size */
        //console.log("data: " + data);
        RFB.fb_width  = data.shift16();
        RFB.fb_height = data.shift16();

        console.log("Screen size: " + RFB.fb_width + "x" + RFB.fb_height);

        /* PIXEL_FORMAT */
        var bpp            = data.shift8();
        var depth          = data.shift8();
        var big_endian     = data.shift8();
        var true_color     = data.shift8();

        console.log("bpp: " + bpp);
        console.log("depth: " + depth);
        console.log("big_endian: " + big_endian);
        console.log("true_color: " + true_color);

        /* Connection name/title */
        data.shiftStr(12);
        var name_length   = data.shift32();
        RFB.fb_name = data.shiftStr(name_length);

        console.log("Name: " + RFB.fb_name);
        $('status').innerHTML = "Connected to: " + RFB.fb_name;

        Canvas.init('vnc', RFB.fb_width, RFB.fb_height, RFB.keyDown, RFB.keyUp);

        var init = [];
        init = init.concat(RFB.pixelFormat());
        init = init.concat(RFB.encodings());
        init = init.concat(RFB.fbUpdateRequest(0, 0, 0, RFB.fb_width, RFB.fb_height));
        RFB.send_array(init);
        
        /* Start polling */
        RFB.poller.delay(RFB.poll_rate);

        RFB.state = 'normal';
        break;
    }
    console.log("<< init_msg (" + RFB.state + ")");
},

/* Framebuffer update display functions */
display_raw: function () {
    console.log(">> display_raw");
    Canvas.rfbImage(FBU.x, FBU.y, FBU.width, FBU.height, FBU.arr);
    FBU.arr.splice(0, FBU.width * FBU.height * RFB.fb_Bpp);
    FBU.rects --;
},

display_copy_rect: function () {
    console.log(">> display_copy_rect");
    var old_x = FBU.arr.shift16();
    var old_y = FBU.arr.shift16();
    Canvas.copyImage(old_x, old_y, FBU.x, FBU.y, FBU.width, FBU.height);
    FBU.rects --;
},

display_rre: function () {
    //console.log(">> display_rre (" + FBU.arr.length + " bytes)");
    if (FBU.subrects == 0) {
        FBU.subrects = FBU.arr.shift32();
        console.log(">> display_rre " + "(" + FBU.subrects + " subrects)");
        var color = FBU.arr.shiftBytes(RFB.fb_Bpp); // Background
        Canvas.rfbRect(FBU.x, FBU.y, FBU.width, FBU.height, color);
    }
    while ((FBU.subrects > 0) && (FBU.arr.length >= (RFB.fb_Bpp + 8))) {
        FBU.subrects --;
        var color = FBU.arr.shiftBytes(RFB.fb_Bpp);
        var x = FBU.arr.shift16();
        var y = FBU.arr.shift16();
        var width = FBU.arr.shift16();
        var height = FBU.arr.shift16();
        Canvas.rfbRect(FBU.x + x, FBU.y + y, width, height, color);
    }
    //console.log("   display_rre: rects: " + FBU.rects + ", FBU.subrects: " + FBU.subrects);

    if (FBU.subrects > 0) {
        var chunk = Math.min(RFB.rre_chunk, FBU.subrects);
        FBU.bytes = (RFB.fb_Bpp + 8) * chunk;
    } else {
        FBU.rects --;
    }
    //console.log("<< display_rre, FBU.bytes: " + FBU.bytes);
},

display_hextile: function() {
    //console.log(">> display_hextile, tiles: " + FBU.tiles + ", arr.length: " + FBU.arr.length + ", bytes: " + FBU.bytes);
    var subencoding, subrects, cur_tile, tile_x, x, w, tile_y, y, h;

    /* FBU.bytes comes in as 0, FBU.arr.length at least 2 */
    while ((FBU.tiles > 0) && (FBU.arr.length >= FBU.bytes)) {
        cur_tile = FBU.total_tiles - FBU.tiles;
        tile_x = cur_tile % FBU.tiles_x;
        tile_y = Math.floor(cur_tile / FBU.tiles_x);
        x = FBU.x + tile_x * 16;
        y = FBU.y + tile_y * 16;
        w = Math.min(16, (FBU.x + FBU.width) - x)
        h = Math.min(16, (FBU.y + FBU.height) - y)
        subrects = 0;
        if (FBU.subencoding == -1) {
            /* We enter with at least 2 bytes */
            subencoding = FBU.arr[0];  // Peek
            //console.log("   display_hextile, subencoding: " + subencoding);
            FBU.bytes++;   // Since we aren't shifting it off
            //console.log("   subencoding: " + subencoding);
            if (subencoding > 30) { // Raw
                console.log("Illegal subencoding " + subencoding);
                RFB.state = "failed";
                return;
            }

            /* Figure out how much we are expecting */
            if (subencoding & 0x01) { // Raw
                //console.log("   Raw subencoding");
                FBU.bytes = w * h * RFB.fb_Bpp;
                if (FBU.arr[FBU.bytes] == 0) {
                    /* Weird: ignore blanks after RAW */
                    //console.log("     Ignoring blank after RAW");
                    FBU.bytes ++;
                }
            } else {
                if (subencoding & 0x02) { // Background
                    FBU.bytes += RFB.fb_Bpp;
                }
                if (subencoding & 0x04) { // Foreground
                    FBU.bytes += RFB.fb_Bpp;
                }
                if (subencoding & 0x08) { // AnySubrects
                    FBU.bytes++;   // Since we aren't shifting it off
                    if (FBU.arr.length < FBU.bytes) {
                        /* Wait for subrects byte */
                        //console.log("   waiting for subrects byte");
                        return;
                    }
                    subrects = FBU.arr[FBU.bytes-1]; // Peek
                    if (subencoding & 0x10) { // SubrectsColoured
                        FBU.bytes += subrects * (RFB.fb_Bpp + 2);
                    } else {
                        FBU.bytes += subrects * 2;
                    }
                }
            }
        }

        //console.log("   tile:" + cur_tile + "/" + (FBU.total_tiles - 1) + ", subencoding:" + subencoding + ", subrects:" + subrects + ", tile:" + tile_x + "," + tile_y + " [" + x + "," + y + "], arr.length:" + FBU.arr.length + ", bytes:" + FBU.bytes);
        //console.log("   arr[0..30]: " + FBU.arr.slice(0,30));
        if (FBU.arr.length < FBU.bytes) {
            //console.log("   waiting for " + (FBU.bytes - FBU.arr.length) + "bytes");
            return;
        }

        if (subencoding > -1) {
            /* We know the encoding and have a whole tile */
            FBU.subencoding = FBU.arr.shift();
            if (FBU.subencoding == 0) {
                Canvas.rfbRect(x, y, w, h, FBU.background);
            } else if (FBU.subencoding & 0x01) { // Raw
                Canvas.rfbImage(x, y, w, h, FBU.arr);
                FBU.arr.splice(0, FBU.bytes - 1);
            } else {
                if (FBU.subencoding & 0x02) { // Background
                    FBU.background = FBU.arr.shiftBytes(RFB.fb_Bpp);
                    //console.log("   background: " + FBU.background);
                }
                if (FBU.subencoding & 0x04) { // Foreground
                    FBU.foreground = FBU.arr.shiftBytes(RFB.fb_Bpp);
                    //console.log("   foreground: " + FBU.foreground);
                }
                Canvas.rfbRect(x, y, w, h, FBU.background);
                if (FBU.subencoding & 0x08) { // AnySubrects
                    subrects = FBU.arr.shift8();
                    for (var i = 0; i < subrects; i ++) {
                        if (FBU.subencoding & 0x10) { // SubrectsColoured
                            var color = FBU.arr.shiftBytes(RFB.fb_Bpp);
                        } else {
                            var color = FBU.foreground;
                        }
                        var xy = FBU.arr.shift8();
                        var sx = x + (xy >> 4);
                        var sy = y + (xy & 0x0f);

                        var wh = FBU.arr.shift8();
                        var sw = (wh >> 4)   + 1;
                        var sh = (wh & 0x0f) + 1;

                        Canvas.rfbRect(sx, sy, sw, sh, color);
                    }
                }
            }
            FBU.subencoding = -1;
            FBU.tiles --;
            FBU.bytes = 0;
        }
    }

    if (FBU.tiles > 0) {
        FBU.bytes = 2;
    } else {
        FBU.background = [255, 255, 0, 0];  // Yellow: invalid
        FBU.rects --;
    }

    //console.log("<< display_hextile");
},


/* Normal RFB/VNC messages */
normal_msg: function (data) {
    //console.log(">> normal_msg");
    if ((FBU.rects > 0) || (FBU.bytes > 0)) {
        var msg_type = 0;
    } else {
        var msg_type = data.shift8();
    }
    switch (msg_type) {
    case 0:  // FramebufferUpdate
        if (FBU.rects == 0) {
            data.shift8();
            FBU.rects = data.shift16();
            console.log("FramebufferUpdate, " + FBU.rects + " rects");
            FBU.bytes = 0;
            FBU.arr = [];
        } else {
            //console.log("FramebufferUpdate continuation");
        }

        if (data.length > 0 ) {
            FBU.arr = FBU.arr.concat(data);
        }

        while (FBU.arr.length > 0) {
            if (FBU.bytes == 0) {
                FBU.x      = FBU.arr.shift16();
                FBU.y      = FBU.arr.shift16();
                FBU.width  = FBU.arr.shift16();
                FBU.height = FBU.arr.shift16();
                FBU.encoding = parseInt(FBU.arr.shift32(), 10);
                console.log("encoding: " + FBU.encoding);
                switch (FBU.encoding) {
                    case 0:  // Raw
                        FBU.bytes = FBU.width * FBU.height * RFB.fb_Bpp;
                        break;
                    case 1:  // Copy-Rect
                        FBU.bytes = 4;
                        break;
                    case 2:  // RRE
                        FBU.bytes = 4 + RFB.fb_Bpp;
                        break;
                    case 5:  // hextile
                        FBU.bytes = 2;  // No header; get it started
                        FBU.tiles_x = Math.ceil(FBU.width/16);
                        FBU.tiles_y = Math.ceil(FBU.height/16);
                        FBU.total_tiles = FBU.tiles_x * FBU.tiles_y;
                        FBU.tiles = FBU.total_tiles;
                        break;
                    default:
                        console.log("Unsupported encoding " + FBU.encoding);
                        RFB.state = "failed";
                        break;
                }
            }
            //console.log("FBU.arr.length: " + FBU.arr.length + ", FBU.bytes: " + FBU.bytes);

            if (FBU.arr.length >= FBU.bytes) {
                //console.log('Done rect:');
                FBU.bytes = 0;
                
                switch (FBU.encoding) {
                    case 0: RFB.display_raw();       break; // Raw
                    case 1: RFB.display_copy_rect(); break; // Copy-Rect
                    case 2: RFB.display_rre();       break; // RRE
                    case 5: RFB.display_hextile();   break; // hextile
                }
            } else {
                /* We don't have enough yet */
                FBU.bytes = FBU.bytes - data.length;
                break;
            }
            if (RFB.state != "normal") return;
        }

        //console.log("Finished frame buffer update");
        break;
    case 1:  // SetColourMapEntries
        console.log("SetColourMapEntries");
        break;
    case 2:  // Bell
        console.log("Bell");
        break;
    case 3:  // ServerCutText
        console.log("ServerCutText");
        break;
    default:
        console.log("Unknown server message type: " + msg_type);
        break;
    }
    //console.log("<< normal_msg");
},

/*
 * Client message routines
 */

pixelFormat: function () {
    console.log(">> setPixelFormat");
    var arr;
    arr = [0];     // msg-type
    arr.push8(0);  // padding
    arr.push8(0);  // padding
    arr.push8(0);  // padding

    arr.push8(RFB.fb_Bpp * 8); // bits-per-pixel
    arr.push8(24); // depth
    arr.push8(0);  // little-endian
    arr.push8(1);  // true-color

    arr.push16(255);  // red-max
    arr.push16(255);  // green-max
    arr.push16(255);  // blue-max
    arr.push8(0);     // red-shift
    arr.push8(8);     // green-shift
    arr.push8(16);    // blue-shift

    arr.push8(0);     // padding
    arr.push8(0);     // padding
    arr.push8(0);     // padding
    console.log("<< setPixelFormat");
    return arr;
},

fixColourMapEntries: function () {
},

encodings: function () {
    console.log(">> setEncodings");
    var arr;
    arr = [2];     // msg-type
    arr.push8(0);  // padding

    //arr.push16(3); // encoding count
    arr.push16(4); // encoding count
    arr.push32(5); // hextile encoding

    arr.push32(2); // RRE encoding
    arr.push32(1); // copy-rect encoding
    arr.push32(0); // raw encoding
    console.log("<< setEncodings");
    return arr;
},

fbUpdateRequest: function (incremental, x, y, xw, yw) {
    //console.log(">> fbUpdateRequest");
    var arr;
    arr = [3];  // msg-type
    arr.push8(incremental);
    arr.push16(x);
    arr.push16(y);
    arr.push16(xw);
    arr.push16(yw);
    //console.log("<< fbUpdateRequest");
    return arr;
},

keyEvent: function (keysym, down) {
    console.log(">> keyEvent, keysym: " + keysym + ", down: " + down);
    var arr;
    arr = [4];  // msg-type
    arr.push8(down);
    arr.push16(0);
    arr.push32(keysym);
    //console.log("keyEvent array: " + arr);
    arr = arr.concat(RFB.fbUpdateRequest(1, 0, 0, RFB.fb_width, RFB.fb_height));
    RFB.send_array(arr);
    //console.log("<< keyEvent");
},

pointerEvent: function () {
},

clientCutText: function () {
},


/*
 * Utility routines
 */

send_string: function (str) {
    //console.log(">> send_string: " + str);
    RFB.send_array(str.split('').map(
        function (chr) { return chr.charCodeAt(0) } ) );
},

send_array: function (arr) {
    //console.log(">> send_array: " + arr);
    //console.log(">> send_array: " + Base64.encode_array(arr));
    RFB.ws.send(Base64.encode_array(arr));
},

/* Mirror bits of each character and return as array */
passwdTwiddle: function (passwd) {
    var arr;
    arr = [];
    for (var i=0; i< passwd.length; i++) {
        var c = passwd.charCodeAt(i);
        arr.push( ((c & 0x80) >> 7) +
                  ((c & 0x40) >> 5) +
                  ((c & 0x20) >> 3) +
                  ((c & 0x10) >> 1) +
                  ((c & 0x08) << 1) +
                  ((c & 0x04) << 3) +
                  ((c & 0x02) << 5) +
                  ((c & 0x01) << 7)   );
    }
    return arr;
},

poller: function () {
    if (RFB.state == 'normal') {
        RFB.send_array(RFB.fbUpdateRequest(1, 0, 0, RFB.fb_width, RFB.fb_height));
        RFB.poller.delay(RFB.poll_rate);
    }
},

keyDown: function (e) {
    //console.log(">> keyDown: " + e.key + "(" + e.code + ")");
    e.stop();
    RFB.keyEvent(Canvas.getKeysym(e), 1);
},

keyUp: function (e) {
    //console.log(">> keyUp: " + e.key + "(" + e.code + ")");
    e.stop();
    RFB.keyEvent(Canvas.getKeysym(e), 0);
},


/*
 * Setup routines
 */

init_ws: function () {
    console.log(">> init_ws");
    var uri = "ws://" + RFB.host + ":" + RFB.port;
    console.log("connecting to " + uri);
    RFB.ws = new WebSocket(uri);
    RFB.ws.onmessage = function(e) {
        //console.log(">> onmessage");
        var data = Base64.decode_array(e.data);
        //console.log("decoded array: " + data);
        if (RFB.state != 'normal') {
            RFB.init_msg(data);
        } else {
            RFB.normal_msg(data);
        }
        if (RFB.state == 'reset') {
            /* close and reset connection */
            RFB.disconnect();
            RFB.init_ws();
        } else if (RFB.state == 'failed') {
            console.log("Giving up!");
            RFB.disconnect();
        }
        //console.log("<< onmessage");
    };
    RFB.ws.onopen = function(e) {
        console.log(">> onopen");
        RFB.state = "ProtocolVersion";
        console.log("<< onopen");
    };
    RFB.ws.onclose = function(e) {
        console.log(">> onclose");
        RFB.state = "closed";
        console.log("<< onclose");
    }

    console.log("<< init_ws");
},

connect: function () {
    console.log(">> connect");
    RFB.host = $('host').value;
    RFB.port = $('port').value;
    RFB.password = $('password').value;
    if ((!host) || (!port)) {
        console.log("must set host and port");
        return;
    }
    if (RFB.ws) {
        RFB.ws.close();
    }
    RFB.init_ws();
    $('connectButton').value = "Disconnect";
    $('connectButton').onclick = RFB.disconnect;
    console.log("<< connect");

},

disconnect: function () {
    console.log(">> disconnect");
    if (RFB.ws) {
        RFB.ws.close();
    }
    if (Canvas.ctx) {
        Canvas.clear();
    }
    $('connectButton').value = "Connect";
    $('connectButton').onclick = RFB.connect;
    $('status').innerHTML = "Disconnected";
    console.log("<< disconnect");
}

}; /* End of RFB */