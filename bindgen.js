"use strict";

const webidl = require('webidl2');
const fs = require('fs');
const prettyjson = require('prettyjson');
const util = require('util');
const f = util.format;

var outbase = process.argv[3];
if (!outbase) {
  throw "need an output base filename";
}

var infile = fs.readFileSync(process.argv[2], 'utf8');
var tree = webidl.parse(infile);

var interfaces = {};
var typedefs = {};

function hasExtAttr(attrs, aname, value) {
  if (!attrs)
    return undefined;
  for (var attr of attrs) {
    if (attr.name == aname) {
      if (value !== undefined) {
        if (attr.rhs && attr.rhs.value == value)
          return attr;
        return false;
      }
      return attr;
    }
  }
  return undefined;
}

//
// Type resolution
//

var resolvedTypes = {};

function isBasicType(type) {
  if (typeof(type) != 'string')
    return false;
  switch (type) {
    case 'boolean':
    case 'byte':
    case 'octet':
    case 'short':
    case 'unsigned short':
    case 'long':
    case 'unsigned long':
    case 'long long':
    case 'unsigned long long':
    case 'float':
    case 'double':
      return true;
    case 'int':
    case 'unsigned int':
      throw "int is not a WebIDL type";
    default:
      return false;
  }
}

function CppBasicType(type) {
  if (typeof(type) != 'string')
    return undefined;
  switch (type) {
    case 'boolean':
      return 'bool';
    case 'byte':
      return 'unsigned char';
    case 'octet':
      return 'char';
    case 'DOMString':
      return 'char *';
    case 'short':
    case 'unsigned short':
    case 'long':
    case 'unsigned long':
    case 'long long':
    case 'unsigned long long':
    case 'float':
    case 'double':
      return type;
    default:
      return undefined;
  }
}

function typeKey(idlType, attrs) {
  var key = "";
  if (typeof(idlType) == 'string')
    return idlType;

  if (idlType.union) {
    throw "union types not supported";
  }

  if (idlType.sequence) key += "[]";
  if (idlType.nullable) key += "?";
  if (hasExtAttr(attrs, "Ref")) key += "&";
  if (hasExtAttr(attrs, "Value")) key += "!";
  if (hasExtAttr(attrs, "Const")) key += "#";
  if (key.length > 0) key += "-";
  if (idlType.sequence) {
    key += typeKey(idlType.idlType);
  } else if (typeof(idlType.idlType) == 'string') {
    key += idlType.idlType;
  } else {
    throw "shouldn't get here";
  }

  return key;
}

function resolveType(idlType, attrs) {
  var key = typeKey(idlType, attrs);
  if (key in resolvedTypes) {
    return resolvedTypes[key];
  }

  var baseType = idlType;
  if (typeof(baseType) == "string") {
    if (baseType in typedefs) {
      baseType = resolveType(typedefs[baseType]);
    } else {
      // it's a simple type and it's not a typedef, so
      resolvedTypes[key] = baseType;
      return baseType;
    }
  } else if (baseType.sequence) {
    baseType = resolveType(baseType.idlType);
  }

  var itype = baseType;
  while (typeof(itype) == 'object') {
    if (itype.sequence || itype.union || itype.nullable) {
      break;
    }
    itype = resolveType(itype.idlType);
  }

  var byref = !!hasExtAttr(attrs, "Ref");
  var byval = !!hasExtAttr(attrs, "Value");
  var isconst = !!hasExtAttr(attrs, "Const");

  if (idlType.sequence || idlType.union || idlType.nullable || byref || byval || isconst) {
    // if anything makes it not a simple type, then generate an object here; otherwise
    // keep it as a string
    itype = { sequence: idlType.sequence, union: idlType.union, nullable: idlType.nullable,
              byref: byref, byval: byval, isconst: isconst,
              idlType: itype };
  }

  resolvedTypes[key] = itype;
  return itype;
}

function typeEquals(a, b) {
  // special case for easy handling
  if (a === null && a == b)
    return true;

  if (typeof(a) == typeof(b)) {
    if (typeof(a) == 'string') {
      return a == b;
    } else if (typeof(a) == 'object') {
      return a.sequence == b.sequence &&
        a.union == b.union &&
        a.nullable == b.nullable &&
        a.byref == b.byref &&
        a.byval == b.byval &&
        a.isconst == b.isconst &&
        typeEquals(a.idlType, b.idlType);
    } else {
      throw "Invalid type type?";
    }
  }
  return false;
}

function isByValInterfaceType(rtype) {
  if (!rtype) return false;
  return (typeof(rtype) == 'object') && (rtype.byval || rtype.byref) && (rtype.idlType in interfaces);
}

// helper
function objDeepCopyNoFalse(o) {
  if (o instanceof Array) {
    var res = new Array(o.length);
    for (var i = 0; i < o.length; ++i) {
      res[i] = objDeepCopyNoFalse(o[i]);
    }
    return res;
  }

  var n = {};
  for (var prop of Object.getOwnPropertyNames(o)) {
    var val = o[prop];
    if (val === false || val === null || val === undefined)
      continue;
    if (typeof(val) === 'object') {
      val = objDeepCopyNoFalse(val);
    }
    n[prop] = val;
  }
  return n;
}

function pp(o) {
  console.log(prettyjson.render(objDeepCopyNoFalse(o)));
}

const BASE_MODULE = 'Module';
const PFX = 'jsbind_';
const DESTRUCTOR = '__destroy__';

function CppNameFor(ifacename, funcname, nargs) {
  if (!funcname) funcname = ifacename;
  return PFX + ifacename + "_" + funcname + "_" + nargs;
}

function CppConstructorReturnType(type) {
  if (type in interfaces) {
    return interfaces[type].cppName + '*';
  }
  throw `Unknown Cpp constructor return type for '${type}'`;
}

function CppDestructorArgType(type) {
  if (type in interfaces) {
    return interfaces[type].cppName + '*';
  }
  throw `Unknown Cpp destructor type for '${type}'`;
}

function CppArgType(type) {
  let t = CppBasicType(type);
  if (t)
    return t;
  if (typeof(type) === 'string' && type in interfaces) {
    return interfaces[type].cppName + '*';
  }
  if (!type || type == 'void')
    return 'void';
  if (isByValInterfaceType(type)) {
    return CppArgType(type.idlType);
  }
  throw `Unknown Cpp arg type for '${type}'`;
}

function CppReturnType(type) {
  return CppArgType(type);
}

function CppArgs(args) {
  return ForNArgs(args, (i,n,t) => isByValInterfaceType(t.type) ? ('*'+n) : n);
}

// args can be either a number or an argument array
// withSelf - if true, a self argument is prepended [can be omitted]
// joinstr - a string to Array.join the result with [can be omitted, but not if withSelf is specified]
// fns - either a function or a string
//   if a string, args must be a number, and the result is that string + "#" (except for self, which is 'self')
//   if a function, it's called with (index, name, args[index])
function ForNArgs(args, arg1, arg2, arg3) {
  var withSelf = false, joinstr = ', ', fns;
  if (arg2 === undefined) {
    fns = arg1;
  } else if (arg3 === undefined) {
    joinstr = arg1;
    fns = arg2;
  } else {
    withSelf = arg1;
    joinstr = arg2;
    fns = arg3;
  }

  var s = [];
  var offset = 0;
  if (withSelf) {
    offset = 1;
    if (args instanceof Array) {
      var nargs = [{ name: 'self' }];
      nargs = nargs.concat(args);
      args = nargs;
    } else {
      args++;
    }
  }

  if (args instanceof Array) {
    for (var i = 0; i < args.length; ++i) {
      s.push(fns.call(null, i, args[i].name ? args[i].name : ('arg'+(i-offset)), args[i]));
    }
  } else if (typeof(fns) == 'string') {
    for (var i = 0; i < args; ++i) {
      if (withSelf && i == 0) s.push('self');
      else s.push(fns + (i-offset));
    }
  } else {
    for (var i = 0; i < args; ++i) {
      if (withSelf && i == 0) s.push(fns.call(null, 0, 'self'));
      s.push(fns.call(null, i, 'arg'+(i-offset)));
    }
  }
  s = s.filter((v) => !!v);
  return s.join(joinstr);
}

function resolveArgument(arg) {
  return {
    type: resolveType(arg.idlType, arg.extAttrs),
    name: arg.name
  };
}

// generate a statement either pulling out the inner ptr
// from an argument, or moving it into temporary memory
// (for e.g. strings/arrays) if needed.
function MakeJSEnsureArg(index, badname, argtype, needEnsure) {
  let name = "arg" + index;
  if (argtype && isBasicType(argtype.type)) {
    return;
  }
  let s;
  if (argtype.type == 'DOMString') {
    s = `${name} = ensureString(${name});`;
    needEnsure.value = true;
  } else if (argtype && typeof(argtype.type) === 'object') {
    var t = argtype.type;
    if (t.sequence) {
      if (!isBasicType(t.idlType)) {
        throw 'JS argument is a sequence but not of a basic type!';
      }

      switch (t.idlType) {
        case 'boolean':
        case 'byte':
        case 'octet':
          s = `${name} = ensureI8(${name});`;
          break;
        case 'short':
        case 'unsigned short':
          s = `${name} = ensureI16(${name});`;
          break;
        case 'long':
        case 'unsigned long':
          s = `${name} = ensureI32(${name});`;
          break;
        case 'float':
          s = `${name} = ensureF32(${name});`;
          break;
        case 'double':
          s = `${name} = ensureF64(${name});`;
          break;
        default:
          throw `Not sure how to alloc temp sequences of type ${t.idlType}`;
      }
      needEnsure.value = true;
    }
  } else {
     s = `${name} = ${name}.ptr;`;
  }
  return s;
}

function makeJSOverloadedCall(iface, name, isStatic, returnType, overloads) {
  overloads.sort((a,b) => a.length > b.length);
  var maxArgs = 0;
  for (let o of overloads) maxArgs = Math.max(o.length, maxArgs);

  let js = '';
  for (let oi = 0; oi < overloads.length; ++oi) {
    let o = overloads[oi];
    let sep = overloads.length == 1 ? '\n    ' : '\n      ';
    let needEnsure = { value: false };
    let inner = ForNArgs(o, sep, (a,b,c) => MakeJSEnsureArg(a,b,c,needEnsure));
    if (needEnsure.value) {
      inner = 'ensureCache.prepare();' + sep + inner;
    }
    if (inner) inner += sep;
    if (returnType) inner += 'ret = ';
    inner += `_${CppNameFor(iface.name, name, o.length)}(${ForNArgs(o.length, !isStatic, ', ', 'arg')});`;

    if (o.length != maxArgs) {
      if (oi != 0) js += '    else ';
      js += `if (arg${o.length} === undefined) {\n      ${inner}\n    }\n`;
    } else {
      if (oi != 0)
        js += `    else {\n      ${inner}\n    }`;
      else
        js += `${inner}`;
    }
  }
  return js;
}

function handleInterfaceConstructors(iface) {
  let overloads = [];
  let maxArgs = 0;
  for (let attr of iface.extAttrs) {
    if (attr.name != "Constructor")
      continue;
    let args = attr.arguments ? attr.arguments.map(resolveArgument) : [];
    maxArgs = Math.max(args.length, maxArgs);
    overloads.push(args);
  }

  // sort by number of args
  overloads.sort((a,b) => a.length > b.length);

  let constructors = {
    overloads: overloads,
    returnType: iface.name,
    maxArgs: maxArgs
  };

  // generate the JS
  let js = '';
  js += `  constructor(${ForNArgs(maxArgs, 'arg')}) {\n`;
  // we should check and see if an arg in this position could
  // possibly be an object, and only do this if so
  if (constructors.length == 0) {
    js += `    throw "No constructor defined for ${iface.name}";\n`
  } else {
    js += `
    let ret, obj = Object.create(new.target.prototype);
    ${makeJSOverloadedCall(iface, iface.name, true, iface.name, constructors.overloads)}
    obj.ptr = ret;
    ${iface.name}.__setCache(obj);
    return obj;
`;
  }
  js += '  }\n';

  // generate the C++
  var cpp = '';
  cpp += constructors.overloads.map(function(o) {
    let argdecl = ForNArgs(o, function(idx, name, arg) { return CppArgType(arg.type) + ' ' + name; });
    return `
${CppConstructorReturnType(iface.name)} EMSCRIPTEN_KEEPALIVE ${CppNameFor(iface.name, null, o.length)}(${argdecl}) {
  return new ${iface.cppName}(${CppArgs(o)});
}`;
  }).join('\n');

  // destroy helper
  if (!iface.noDestroy) {
    cpp += '\n';
    cpp += `
void EMSCRIPTEN_KEEPALIVE ${CppNameFor(iface.name, DESTRUCTOR, 0)}(${CppDestructorArgType(iface.name)} self) {
  delete self;
}`;
  }

  return { js: js, cpp: cpp };
}

function handleInterfaceMethods(iface) {
  var methods = {};

  for (let m of iface.members) {
    if (m.type != 'operation')
      continue;

    let args = m.arguments ? m.arguments.map(resolveArgument) : [];
    let rtype = resolveType(m.idlType, m.extAttrs);
    let cppName = hasExtAttr(m.extAttrs, "CppName");
    cppName = cppName ? cppName.rhs.value : m.name;
    if (rtype == 'void') rtype = null;
    if (!methods[m.name]) {
      methods[m.name] = {
        name: m.name,
        returnType: rtype,
        cppName: cppName,
        overloads: [],
        isStatic: m.static,
        maxArgs: 0,
      };
    }
    methods[m.name].overloads.push(args);
    methods[m.name].maxArgs = Math.max(methods[m.name].maxArgs, args.length);

    if (methods[m.name].isStatic != m.static) {
      throw `Method ${iface.name}.${m.name} has same name as static method, can't handle this`;
    }
    if (!typeEquals(rtype, methods[m.name].returnType)) {
      throw `Method ${iface.name}.${m.name} overload differs in return type!`;
    }
  }

  var jsmethods = [];
  var cppmethods = [];

  function doMethod(method) {
    let jsName = method.name;
    let cppName = method.cppName;
    let rtype = method.returnType;
    let isStatic = method.isStatic;
    let overloads = method.overloads;
    var maxArgs = method.maxArgs;

    let js = '';
    js += isStatic ? '  static ' : '  ';
    js += `${jsName}(${ForNArgs(maxArgs, 'arg')}) {\n`;
    js += isStatic ? '' : '    let self = this.ptr;\n';
    js += rtype ? '    let ret;\n' : '';
    js += '    ' + makeJSOverloadedCall(iface, cppName, isStatic, rtype, overloads);
    js += '\n';
    if (rtype) {
      if (isBasicType(rtype)) {
        js += '    return ret;\n';
      } else {
        if (rtype === 'DOMString') {
          js += '    return Pointer_stringify(ret);\n';
        } else if (rtype in interfaces) {
          js += `    return ${rtype}.__wrap(ret);\n`;
        } else if (typeof(rtype) == 'string') {
          js += `    return OpaqueWrapperType.__wrap(ret);\n`;
        } else if (isByValInterfaceType(rtype)) {
          js += `    return ${rtype.idlType}.__wrapNoCache(ret);\n`;
        } else {
          throw `Don't know how to handle return types of ${prettyjson.render(rtype)}`;
        }
      }
    }
    js += '  }\n';

    let cpp = '';
    for (let o of overloads) {
      let argdecl = ForNArgs(o, !isStatic, ', ', function(idx, name, arg) { return CppArgType((idx == 0) ? iface.name : arg.type) + ' ' + name; });
      let call = `${isStatic ? (iface.name+'::') : 'self->'}${cppName}(${CppArgs(o)})`;

      cpp += `${CppReturnType(rtype)} EMSCRIPTEN_KEEPALIVE ${CppNameFor(iface.name, cppName, o.length)}(${argdecl}) {\n`;
      if (isByValInterfaceType(rtype)) {
        cpp += `  static ${rtype.idlType} temp;\n`;
        cpp += `  temp = ${call};\n`;
        cpp += `  return &temp;\n`;
      } else {
        cpp += `  ${!!rtype ? 'return ' : ''}${call};\n`;
      }
      cpp += '}\n';
    }

    jsmethods.push(js);
    cppmethods.push(cpp);
  }

  for (var k of Object.keys(methods)) {
    doMethod(methods[k]);
  }

  return { js: jsmethods.join("\n"), cpp: cppmethods.join("\n") };
}

function handleInterfaceAttributes(iface) {
  var attributes = {};
  for (let m of iface.members) {
    if (m.type != 'attribute')
      continue;
  }
}

function handleInterface(iface) {
  let superclass = iface['inheritance'];

  let constructors = handleInterfaceConstructors(iface);
  let methods = handleInterfaceMethods(iface);
  let attributes = handleInterfaceAttributes(iface);

  let js = `
var ${iface.name}___CACHE = {};
class ${iface.name} ${superclass ? 'extends ' + superclass : ''}{
${constructors.js}

${methods.js}

  static __setCache(obj) {
    ${iface.name}___CACHE[obj.ptr] = obj;
  }

  static __wrap(ptr) {
    let obj = ${iface.name}___CACHE[ptr];
    if (!obj) {
      obj = Object.create(${iface.name}.prototype);
      obj.ptr = ptr;
      ${iface.name}___CACHE[ptr] = obj;
    }
    return obj;
  }

  static __wrapNoCache(ptr) {
    let obj = Object.create(${iface.name}.prototype);
    obj.ptr = ptr;
    return obj;
  }
`;
  if (!iface.noDestroy) {
    js += `
  destroy() {
    _${CppNameFor(iface.name, DESTRUCTOR, 0)}(this.ptr);
    delete ${iface.name}___CACHE[this.ptr];
    delete this.ptr;
   }
`;
  }

  js += '}\n';

  return { js: js, cpp: constructors.cpp + '\n' + methods.cpp };
};

var bindings = [];

// preamble, largerly taken from Emscripten's webidl_bind
const jsPreamble = `
// Converts big (string or array) values into a C-style storage, in temporary space

var ensureCache = {
  buffer: 0,  // the main buffer of temporary storage
  size: 0,   // the size of buffer
  pos: 0,    // the next free offset in buffer
  temps: [], // extra allocations
  needed: 0, // the total size we need next time

  prepare: function() {
    if (this.needed) {
      // clear the temps
      for (var i = 0; i < this.temps.length; i++) {
        Module['_free'](this.temps[i]);
      }
      this.temps.length = 0;
      // prepare to allocate a bigger buffer
      Module['_free'](this.buffer);
      this.buffer = 0;
      this.size += this.needed;
      // clean up
      this.needed = 0;
    }
    if (!this.buffer) { // happens first time, or when we need to grow
      this.size += 128; // heuristic, avoid many small grow events
      this.buffer = Module['_malloc'](this.size);
      assert(this.buffer);
    }
    this.pos = 0;
  },
  alloc: function(array, view) {
    assert(this.buffer);
    var bytes = view.BYTES_PER_ELEMENT;
    var len = array.length * bytes;
    len = (len + 7) & -8; // keep things aligned to 8 byte boundaries
    var ret;
    if (this.pos + len >= this.size) {
      // we failed to allocate in the buffer, this time around :(
      assert(len > 0); // null terminator, at least
      this.needed += len;
      ret = Module['_malloc'](len);
      this.temps.push(ret);
    } else {
      // we can allocate in the buffer
      ret = this.buffer + this.pos;
      this.pos += len;
    }
    var retShifted = ret;
    switch (bytes) {
      case 2: retShifted >>= 1; break;
      case 4: retShifted >>= 2; break;
      case 8: retShifted >>= 3; break;
    }
    for (var i = 0; i < array.length; i++) {
      view[retShifted + i] = array[i];
    }
    return ret;
  },
};

function ensureString(value) {
  if (typeof value === 'string') return ensureCache.alloc(intArrayFromString(value), HEAP8);
  return value;
}
function ensureI8(value) {
  if (typeof value === 'object') return ensureCache.alloc(value, HEAP8);
  return value;
}
function ensureI16(value) {
  if (typeof value === 'object') return ensureCache.alloc(value, HEAP16);
  return value;
}
function ensureI32(value) {
  if (typeof value === 'object') return ensureCache.alloc(value, HEAP32);
  return value;
}
function ensureF32(value) {
  if (typeof value === 'object') return ensureCache.alloc(value, HEAPF32);
  return value;
}
function ensureF64(value) {
  if (typeof value === 'object') return ensureCache.alloc(value, HEAPF64);
  return value;
}
`;

/* ======
 * (main)
 * ======
 */
//console.log(prettyjson.render(tree));

for (var item of tree) {
  if (item.type == 'interface') {
    let cppName = hasExtAttr(item.extAttrs, "CppName");
    item.cppName = cppName ? cppName.rhs.value : item.name;

    interfaces[item.name] = item;
  } else if (item.type == 'typedef') {
    typedefs[item.name] = item.idlType;
  }
}

var OpaqueWrapperTypeInterface = {
  name: 'OpaqueWrapperType',
  members: [],
  extAttrs: [],
  noDestroy: true,
};
bindings.push(handleInterface(OpaqueWrapperTypeInterface));

//pp(tree);

for (let name of Object.keys(interfaces)) {
  bindings.push(handleInterface(interfaces[name]));
}

let jsfd = fs.openSync(outbase + '.js', 'w');
fs.writeSync(jsfd, jsPreamble);
for (let b of bindings) {
  fs.writeSync(jsfd, b.js);
}
fs.closeSync(jsfd);

let cppfd = fs.openSync(outbase + '.cpp', 'w');
fs.writeSync(cppfd, "// AUTOMATICALLY GENERATED BY jsbindgen\n");
fs.writeSync(cppfd, "// DO NOT EDIT\n");
fs.writeSync(cppfd, "#include <emscripten.h>\n\n");
fs.writeSync(cppfd, 'extern "C" {\n\n');
for (let b of bindings) {
  fs.writeSync(cppfd, b.cpp);
}
fs.writeSync(cppfd, '\n}\n');
fs.closeSync(cppfd);

