const { organizedPGNs, manufacturerCodes, industryCodes } = require('./fromPgn')
const _ = require('lodash')
const BitStream = require('bit-buffer').BitStream
const Int64LE = require('int64-buffer').Int64LE
const Uint64LE = require('int64-buffer').Uint64LE

const pgns = organizedPGNs()
const manufacturerNames = reverseMap(manufacturerCodes)
const industryNames = reverseMap(industryCodes)
industryNames['Marine'] = 4

const RES_STRINGLAU = 'ASCII or UNICODE string starting with length and control byte'

var fieldTypeWriters = {}
var fieldTypeMappers = {}


var lengthsOff = { 129029: 45, 127257:8, 127258:8, 127251:8 }

function toPgn(data) {
  var pgnList = pgns[data.pgn]
  if (!pgnList) {
    console.log("no pgn found: " + data.pgn)
    return
  }
  
  var pgnData = pgnList[0]

  var bs = new BitStream(new Buffer(500))

  if ( data.fields ) {
    data = data.fields
  }

  var fields = pgnData.Fields
  if ( !_.isArray(fields) ) {
    fields = [ fields.Field ]
  }
  
  for ( var index = 0; index < fields.length - pgnData.RepeatingFields; index++ ) {
    var field = fields[index]
    var value = data[field.Name];

    if ( !_.isUndefined(field.Match) ) {
      //console.log(`matching ${field.Name} ${field.Match} ${value} ${_.isString(value)}`)
      if ( _.isString(value) ) {
        pgnList = pgnList.filter(f => f.Fields[index].Description == value)
      } else {
        pgnList = pgnList.filter(f => f.Fields[index].Match == value)
      }
      if ( pgnList.length > 0 ) {
        //console.log(`matched ${field.Name} ${pgnList[0].Fields[index].Match}`)
        pgnData = pgnList[0]
        value = pgnData.Fields[index].Match
        fields = pgnData.Fields
      } 
    }
    writeField(bs, field, value)
  }

  if ( data.list ) {
    data.list.forEach(repeat => {
      for (var index = 0; index < pgnData.RepeatingFields; index++ ) {
        var field = fields[pgnData.Fields.length-pgnData.RepeatingFields+index]
        var value = repeat[field.Name];

        writeField(bs, field, value)
      }
    })
  }

  var bitsLeft = (bs.byteIndex * 8) - bs.index
  if ( bitsLeft > 0 ) {
    //finish off the last byte
    bs.writeBits(0xffff, bitsLeft)
    //console.log(`bits left ${bitsLeft}`)
  }
  
  if ( pgnData.Length != 0xff
       && fields[fields.length-1].Type != RES_STRINGLAU) {

    var len = lengthsOff[pgnData.PGN] || pgnData.Length
    //console.log(`Length ${len}`)
    
    if ( bs.byteIndex < len ) {
      //console.log(`bytes left ${pgnData.Length-bs.byteIndex}`)
    }

    for ( var i = bs.byteIndex; i < len; i++ ) {
      bs.writeUint8(0xff)
    }
  }
  
  return bs.view.buffer.slice(0, bs.byteIndex)
}

function dumpWritten(bs, field, startPos, value) {
  //console.log(`${startPos} ${bs.byteIndex}`)
  if ( startPos == bs.byteIndex )
    startPos--
  var string = `${field.Name} (${field.BitLength}): [`
  for ( var i = startPos; i < bs.byteIndex; i++ ) {
    string = string + bs.view.buffer[i].toString(16) + ', '
  }
  console.log(string + `] ${value}`)
}

function writeField(bs, field, value) {
  var startPos = bs.byteIndex

  //console.log(`${field.Name} ${value} ${field.BitLength} ${field.Resolution}`)
  if ( _.isUndefined(value) ) {
    if ( field.Type && fieldTypeWriters[field.Type] ) {
      fieldTypeWriters[field.Type](field, value, bs)
    } else if ( field.BitLength % 8  == 0 ) {
      var bytes = field.BitLength/8
      var lastByte = field.Signed ? 0x7f : 0xff
      var byte = field.Name == 'Reserved' ? 0x00 : 0xff
      for ( var i = 0; i < bytes-1; i++ ) {
        bs.writeUint8(0xff)
      }
      bs.writeUint8(field.Signed ? 0x7f : 0xff)
    } else {
      bs.writeBits(0xffffff, field.BitLength)
    }
  } else {
    
    if ( field.Name === 'Industry Code' ) {
      if ( _.isString(value) ) {
        value = Number(industryNames[value])
      }
    } else if ( field.Type && fieldTypeMappers[field.Type] ) {
      value = fieldTypeMappers[field.Type](field, value)
    } else if (field.EnumValues && _.isString(value)) {
      if (!(field.Id === "timeStamp" && value < 60)) {
        value = lookup(field, value)
      }
    }
    
    if (field.Resolution) {
      value = (value / field.Resolution).toFixed(0);
    }

    if ( field.Type && fieldTypeWriters[field.Type] ) {
      fieldTypeWriters[field.Type](field, value, bs)
    } else {
      if ( _.isString(value) ) {
        value = Number(value)
      }

      if ( field.Units === "kWh" ) {
        value /= 3.6e6; // 1 kWh = 3.6 MJ.
      } else if (field.Units === "Ah") {
        value /= 3600.0; // 1 Ah = 3600 C.
      }
      /*
      if ( field.Offset ) {
        value -= field.Offset
      }
      */

      if (field.BitLength === 8) {
        if (field.Signed) {
          bs.writeInt8(value)
        } else {
          bs.writeUint8(value)
        }
      } else if (field.BitLength === 16) {
        if (field.Signed) {
          bs.writeInt16(value)
        } else {
          bs.writeUint16(value)
        }
      } else if (field.BitLength === 32) {
        if (field.Signed) {
          bs.writeInt32(value)
        } else {
          bs.writeUint32(value)
        }
      } else if (field.BitLength === 48 || field.BitLength == 24) {
        var count = field.BitLength/8;
        var val = value;
        if ( value < 0 ) {
          val++
        }
        while (count-- > 0 ) {
          if ( value > 0 ) {
            bs.writeUint8(val & 255);
            val /= 256;
          } else {
            bs.writeUint8(((-val) & 255) ^ 255);
            val /= 256;
          }
        }
      } else if (field.BitLength === 64) {
        var num
        if (field.Signed) {
          num = new Int64LE(value)
        } else {
          num = new Int64LE(value)
        }
        var buf = num.toBuffer()
        buf.copy(bs.view.buffer, bs.byteIndex)
        bs.byteIndex += buf.length
      } else {
        bs.writeBits(value, field.BitLength)
      }
    }
  }
  //dumpWritten(bs, field, startPos, value)
}

function lookup(field, stringValue) {
  if (!field.name2value) {
    field.name2value = {};
    field.EnumValues.forEach(function(enumPair) {
      field.name2value[enumPair.name] = Number(enumPair.value)
    })
  }
  var res = field.name2value[stringValue];
  return _.isUndefined(res) ? stringValue : res
}

function isDefined(value) {
  return typeof value !== 'undefined' && value != null
}

function parseHex(s) {
  return parseInt(s, 16)
};

function canboat2Buffer(canboatData) {
  return new Buffer(canboatData.split(',').slice(6).map(parseHex), 'hex');
}

function toActisenseSerialFormat(pgn, data, dst=255, src=0) {
  return (
    new Date().toISOString() +
      ",2," +
      pgn +
      `,${src},${dst},` +
      data.length +
      "," +
      new Uint32Array(data)
      .reduce(function(acc, i) {
        acc.push(i.toString(16));
        return acc;
      }, [])
      .map(x => (x.length === 1 ? "0" + x : x))
      .join(",")
  );
}

fieldTypeWriters['ASCII text'] = (field, value, bs) => {
  if ( _.isUndefined(value) ) {
    value = ""
  }
  var fieldLen = field.BitLength / 8

  for ( var i = 0; i < value.length; i++ ) {
    bs.writeUint8(value.charCodeAt(i))
  }

  for ( var i = 0; i < fieldLen - value.length; i++ ) {
    bs.writeUint8(0xff)
  }
}

fieldTypeWriters["String with start/stop byte"] = (field, value, bs) => {
  if ( _.isUndefined(value) ) {
    value = ""
  }
  bs.writeUint8(0x02)
  for ( var i = 0; i < value.length; i++ ) {
    bs.writeUint8(value.charCodeAt(i))
  }
  bs.writeUint8(0x01)
}

fieldTypeWriters[RES_STRINGLAU] = (field, value, bs) => {

  bs.writeUint8(value.length+1)
  bs.writeUint8(0)
  
  for ( var idx = 0; idx < value.length; idx++ ) {
    bs.writeUint8(value.charCodeAt(idx))
  }
}


fieldTypeMappers['Date'] = (field, value) => {
  //console.log(`Date: ${value}`)
  if ( _.isString(value) ) {
    var date = new Date(value)
    return date.getTime() / 86400 / 1000
  }
  
  return value
}

fieldTypeMappers['Time'] = (field, value) => {
  if ( _.isString(value) ) {
    var split = value.split(':')

    var hours = Number(split[0])
    var minutes = Number(split[1])
    var seconds = Number(split[2])

    value = (hours * 60 * 60) + (minutes * 60) + seconds
  }
  return value
}


fieldTypeMappers['Manufacturer code'] = (field, value) => {
  if ( _.isString(value) ) {
    value = manufacturerNames[value]
  }
  return Number(value)
}

fieldTypeMappers['Pressure'] = (field, value) => {
  if (field.Units)
  {
    switch (field.Units[0]) {
    case 'h':
    case 'H':
      value /= 100;
      break;
    case 'k':
    case 'K':
      value /= 1000;
      break;
    case 'd':
      value *= 10;
      break;
    }
  }
  return value
}


function reverseMap(map) {
  var res = {}
  _.keys(map).forEach(key => {
    res[map[key]] = key
  })
  return res
}

module.exports.canboat2Buffer = canboat2Buffer
module.exports.toPgn = toPgn
module.exports.toActisenseSerialFormat = toActisenseSerialFormat
