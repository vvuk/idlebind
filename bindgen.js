"use strict";

const webidl = require('webidl2');
const fs = require('fs');
const prettyjson = require('prettyjson');
const util = require('util');
const f = util.format;

let ES6 = false;

let interfaces = {};
let typedefs = {};
let callbacks = {};
let valuetypes = {};

function hasExtAttr(attrs, aname, value) {
  if (!attrs)
    return undefined;
  for (let attr of attrs) {
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

let resolvedTypes = {};

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
  let key = "";
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
  let key = typeKey(idlType, attrs);
  if (key in resolvedTypes) {
    return resolvedTypes[key];
  }

  let baseType = idlType;
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

  let itype = baseType;
  while (typeof(itype) == 'object') {
    if (itype.sequence || itype.union || itype.nullable) {
      break;
    }
    itype = resolveType(itype.idlType);
  }

  let byref = !!hasExtAttr(attrs, "Ref");
  let isconst = !!hasExtAttr(attrs, "Const");

  if (idlType.sequence || idlType.union || idlType.nullable || byref || isconst) {
    // if anything makes it not a simple type, then generate an object here; otherwise
    // keep it as a string
    itype = { sequence: idlType.sequence, union: idlType.union, nullable: idlType.nullable,
              byref: byref, isconst: isconst,
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
        a.isconst == b.isconst &&
        typeEquals(a.idlType, b.idlType);
    } else {
      throw "Invalid type type?";
    }
  }
  return false;
}

// helper
function objDeepCopyNoFalse(o) {
  if (o instanceof Array) {
    let res = new Array(o.length);
    for (let i = 0; i < o.length; ++i) {
      res[i] = objDeepCopyNoFalse(o[i]);
    }
    return res;
  }

  let n = {};
  for (let prop of Object.getOwnPropertyNames(o)) {
    let val = o[prop];
    if (val === false || val === null || val === undefined)
      continue;
    if (typeof(val) === 'object') {
      val = objDeepCopyNoFalse(val);
    }
    n[prop] = val;
  }
  return n;
}

function indentLines(srcstr, pad) {
  return srcstr.replace(/\n/g, `\n${pad}`);
}

function pp(o) {
  console.log(prettyjson.render(objDeepCopyNoFalse(o)));
}

var MODULE, PRIVATE, OFFSET_TABLE;
function setModuleName(name) {
  MODULE = name;
  PRIVATE = `${MODULE}__private`;
  OFFSET_TABLE = `${PRIVATE}.offsetTable`;
}

const PFX = 'jsbind_';
const DESTRUCTOR = '__DESTROY__';
const CALL_WITH_TOKEN = '__CB__';

function CppNameFor(ifacename, funcname, nargs) {
  if (!funcname) funcname = ifacename;
  return PFX + ifacename + "_" + funcname + "_" + nargs;
}

function CppPropNameFor(ifacename, propname, issetter) {
  return PFX + ifacename + (issetter ? "___SET___" : "___GET___") + propname;
}

function CppConstructorDestructorType(type) {
  let iface = interfaces[type];
  if (!iface)
    throw `Unknown Cpp constructor/destructor type for '${type}'`;
  if (iface.sharedPtr)
    return `std::shared_ptr<${iface.cppName}>*`;
  return iface.cppName + '*';
}

function CppSelfArgType(type) {
  let iface = interfaces[type];
  if (!iface)
    throw `Unknown Cpp self type for '${type}'`;
  // note const ref here; we can still pass in the address from JS side,
  // but C++ side can still use it like "self->foo()"
  if (iface.sharedPtr)
    return `const std::shared_ptr<${iface.cppName}>&`;
  return iface.cppName + '*';
}

function CppArgType(type) {
  let t = CppBasicType(type);
  if (t)
    return t;
  if (!type || type == 'void')
    return 'void';
  if (type in interfaces)
    return CppSelfArgType(type);
  if (type in callbacks)
    return 'long';
  if (type in valuetypes)
    return `const ${type}&`;
  if (type.byref)
    return `const ${type.idlType}&`;
  throw `Unknown Cpp arg type for '${prettyjson.render(type)}'`;
}

function CppReturnType(type) {
  if (type in interfaces && interfaces[type].sharedPtr)
    return `std::shared_ptr<${type}>*`;
  if (type in valuetypes)
    return `const ${type}*`;
  return CppArgType(type);
}

function CppCallbackReturnType(type) {
  if (type in interfaces && interfaces[type].sharedPtr) {
    return `std::shared_ptr<${type}>`;
  }
  return CppArgType(type);
}

function CppArgs(args) {
  return ForNArgs(args, function (i,name,arg) {
    if (arg.type in callbacks) {
      let cb = callbacks[arg.type];
      // the incoming value is just a long; we need to convert it to an appropriate std::function
      let s = `std::bind(${cb.CppCallWithTokenName}, ${name}`;
      let placeholders = ForNArgs(cb.arguments.length, (i,n,t) => "std::placeholders::_" + (i+1));
      if (placeholders)
        s += ", " + placeholders;
      s += ")";
      return s;
    }
    return name;
  });
}

// args can be either a number or an argument array
// classType - if non-null, a 'self' argument of this type is prepended to the arg list
// joinstr - a string to Array.join the result with [can be omitted, but not if classType is specified]
// fns - either a function or a string
//   if a string, args must be a number, and the result is that string + "#" (except for self, which is 'self')
//   if a function, it's called with (index, name, args[index])
function ForNArgs(args, arg1, arg2, arg3) {
  let classType = undefined, joinstr = ', ', fns;
  if (arg2 === undefined) {
    fns = arg1;
  } else if (arg3 === undefined) {
    joinstr = arg1;
    fns = arg2;
  } else {
    classType = arg1;
    joinstr = arg2;
    fns = arg3;
  }

  let s = [];
  let offset = 0;
  if (classType) {
    offset = 1;
    if (args instanceof Array) {
      let nargs = [{ name: 'self', type: classType }];
      nargs = nargs.concat(args);
      args = nargs;
    } else {
      args++;
    }
  }

  if (args instanceof Array) {
    for (let i = 0; i < args.length; ++i) {
      s.push(fns.call(null, i, args[i].name ? args[i].name : ('arg'+(i-offset)), args[i]));
    }
  } else if (typeof(fns) == 'string') {
    for (let i = 0; i < args; ++i) {
      if (classType && i == 0) s.push('self');
      else s.push(fns + (i-offset));
    }
  } else {
    for (let i = 0; i < args; ++i) {
      if (classType && i == 0) s.push(fns.call(null, 0, 'self'));
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
function MakeJSHeapPtrArg(index, argtype, needTempHeapPtr) {
  let name = "arg" + index;
  if (isBasicType(argtype))
    return;
  let s;
  if (argtype == 'DOMString') {
    s = `${name} = ${PRIVATE}.tempHeapPtrString(${name});`;
    needTempHeapPtr.value = true;
  } else if (typeof(argtype) === 'object' && argtype.sequence) {
    if (!isBasicType(argtype.idlType)) {
      throw 'JS argument is a sequence but not of a basic type!';
    }
    switch (argtype.idlType) {
      case 'boolean':
      case 'byte':
      case 'octet':
        s = `${name} = ${PRIVATE}.tempHeapPtrI8(${name});`;
        break;
      case 'short':
      case 'unsigned short':
        s = `${name} = ${PRIVATE}.tempHeapPtrI16(${name});`;
        break;
      case 'long':
      case 'unsigned long':
        s = `${name} = ${PRIVATE}.tempHeapPtrI32(${name});`;
        break;
      case 'float':
        s = `${name} = ${PRIVATE}.tempHeapPtrF32(${name});`;
        break;
      case 'double':
        s = `${name} = ${PRIVATE}.tempHeapPtrF64(${name});`;
        break;
      default:
        throw `Not sure how to alloc temp sequences of type ${t.idlType}`;
    }
    needTempHeapPtr.value = true;
  } else if (argtype in valuetypes) {
    s = `{ let p = ${PRIVATE}.tempHeapPtrBuffer(${OFFSET_TABLE}[${valuetypes[argtype].sizeOfIndex}]); ${name}.__toPointer(p); ${name} = p; }`;
    needTempHeapPtr.value = true;
  } else if (argtype in callbacks) {
    s = `${name} = ${PRIVATE}.${argtype}__token_for_fn(${name})`;
  } else {
    s = `${name} = ${name}.ptr;`;
  }
  return s;
}

function makeJSOverloadedCall(iface, name, isStatic, returnType, overloads) {
  overloads.sort((a,b) => a.length > b.length);
  let maxArgs = 0;
  for (let o of overloads) maxArgs = Math.max(o.length, maxArgs);

  let js = '';
  for (let oi = 0; oi < overloads.length; ++oi) {
    let o = overloads[oi];
    let sep = overloads.length == 1 ? '\n  ' : '\n    ';

    // generate a call to the right overload, based on number of arguments
    let needTempHeapPtr = { value: false };
    let inner = ForNArgs(o, sep, (idx,b,argtype) => MakeJSHeapPtrArg(idx,argtype.type,needTempHeapPtr));
    if (needTempHeapPtr.value) {
      inner = `${PRIVATE}.tempHeapCache.prepare();` + sep + inner;
    }
    if (inner) inner += sep;
    if (returnType) inner += 'ret = ';
    inner += `_${CppNameFor(iface.name, name, o.length)}(${ForNArgs(o.length, isStatic ? false : iface.name, ', ', 'arg')});`;

    // actually select it in the JS, based on the number of arguments passed in (with
    // later arguments being undefined).  We generate an if/else chain.
    if (o.length != maxArgs) {
      if (oi != 0) js += '  else ';
      js += `if (arg${o.length} === undefined) {\n    ${inner}\n  }\n`;
    } else if (oi != 0) {
      js += `  else {\n    ${inner}\n  }`;
     } else {
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
  js += `(${ForNArgs(maxArgs, 'arg')}) {`;
  // we should check and see if an arg in this position could
  // possibly be an object, and only do this if so
  if (constructors.overloads.length == 0) {
    js += `\n  throw "No constructor defined for ${iface.name}";\n`
  } else {
    js += `
  let ret, obj = Object.create(new.target.prototype);
  ${makeJSOverloadedCall(iface, iface.name, true, iface.name, constructors.overloads)}
  obj.ptr = ret;
  ${iface.name}.__setCache(obj);
  return obj;
`;
  }
  js += '}';

  // generate the C++
  let cpp = '';
  cpp += constructors.overloads.map(function(o) {
    let argdecl = ForNArgs(o, function(idx, name, arg) { return CppArgType(arg.type) + ' ' + name; });
    let construct;
    if (iface.sharedPtr) {
      // we have to heap-construct a shared ptr
      construct = `new std::shared_ptr<${iface.cppName}>(std::make_shared<${iface.cppName}>(${CppArgs(o)}))`;
    } else {
      construct = `new ${iface.cppName}(${CppArgs(o)})`;
    }
    return `${CppConstructorDestructorType(iface.name)} EMSCRIPTEN_KEEPALIVE ${CppNameFor(iface.name, null, o.length)}(${argdecl}) {
  return ${construct};
}`;
  }).join('\n');

  // destroy helper
  if (!iface.noDestroy) {
    cpp += '\n';
    cpp += `void EMSCRIPTEN_KEEPALIVE ${CppNameFor(iface.name, DESTRUCTOR, 0)}(${CppConstructorDestructorType(iface.name)} self) {\n`
    if (iface.sharedPtr)
      cpp += '  self->reset();\n';
    cpp += '  delete self;\n';
    cpp += '}';
  }

  return { js: js, cpp: cpp };
}

function makeJSFromCppValue(type, ret, nocache)
{
  if (isBasicType(type))
    return `${ret}`;
  if (type === 'DOMString')
    return `Pointer_stringify(${ret})`;
  if (type in interfaces)
    return `${MODULE}.${type}.__wrap${nocache?'NoCache':''}(${ret})`;
  if (type in valuetypes)
    return `${MODULE}.${type}.__fromPointer(${ret})`;
  throw `Don't know how to handle JS to C++ types of ${prettyjson.render(type)}`;
}

function makeJSReturnFor(rtype, ret) {
  return 'return ' + makeJSFromCppValue(rtype, ret) + ';';
}

function handleInterfaceMethods(iface) {
  let methods = {};

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

  let jsmethods = [];
  let cppmethods = [];

  for (let k of Object.keys(methods)) {
    let method = methods[k];
    let jsName = method.name;
    let cppName = method.cppName;
    let rtype = method.returnType;
    let isStatic = method.isStatic;
    let overloads = method.overloads;
    let maxArgs = method.maxArgs;

    let js = '';
    js += `(${ForNArgs(maxArgs, 'arg')}) {\n`;
    js += isStatic ? '' : '  let self = this.ptr;\n';
    js += rtype ? '  let ret;\n' : '';
    js += '  ' + makeJSOverloadedCall(iface, cppName, isStatic, rtype, overloads);
    js += '\n';
    if (rtype) {
      js += '  ' + makeJSReturnFor(rtype, 'ret') + '\n';
    }
    js += '}';

    jsmethods.push({ name: jsName, src: js, isStatic: isStatic });

    let cpp = '';
    for (let o of overloads) {
      let argdecl;
      if (isStatic) {
        argdecl = ForNArgs(o, ', ', (idx, name, arg) => CppArgType(arg.type) + ' ' + name);
      } else {
        argdecl = ForNArgs(o, iface.name, ', ', (idx, name, arg) => (idx==0 ? CppSelfArgType(arg.type) : CppArgType(arg.type)) + ' ' + name);
      }
      let call = `${isStatic ? (iface.name+'::') : 'self->'}${cppName}(${CppArgs(o)})`;

      cpp += `${CppReturnType(rtype)} EMSCRIPTEN_KEEPALIVE ${CppNameFor(iface.name, cppName, o.length)}(${argdecl}) {\n`;
      if (rtype in valuetypes) {
        cpp += `  static ${rtype} temp;\n`;
        cpp += `  temp = ${call};\n`;
        cpp += `  return &temp;\n`;
      } else if (rtype in interfaces && interfaces[rtype].sharedPtr) {
        // TODO ${call} must return a std::shared_ptr<$rtype> -- can't be a bare
        // pointer. Would be nice to enforce this somehow, because this will silently
        // compile if $call returns a $rtype*
        cpp += `  return jsbind_maybe_make_shared<${rtype}>(${call});\n`;
      } else {
        cpp += `  ${!!rtype ? 'return ' : ''}${call};\n`;
      }
      cpp += '}\n';
    }

    cppmethods.push(cpp);
  }

  return { jsmethods: jsmethods, cpp: cppmethods.join("\n") };
}

function handleInterfaceAttributes(iface) {
  let attributes = {};
  for (let m of iface.members) {
    if (m.type != 'attribute')
      continue;
    let cppName = hasExtAttr(m.extAttrs, "CppName");
    cppName = cppName ? cppName.rhs.value : m.name;

    m.cppName = cppName;
    m.idlType = resolveType(m.idlType);
    attributes[m.name] = m;
  }

  let jsattrs = [];
  let cppattrs = [];

  for (let k of Object.keys(attributes)) {
    let attr = attributes[k];

    let js = `
  get ${attr.name}() {
    let ret = _${CppPropNameFor(iface.name, attr.name, false)}(${attr.static ? '' : 'this.ptr'});
    ${makeJSReturnFor(attr.idlType, 'ret')}
  }`;

    let cpp = `${CppReturnType(attr.idlType)} EMSCRIPTEN_KEEPALIVE `
    cpp += `${CppPropNameFor(iface.name, attr.name, false)}(${attr.static ? '' : (CppSelfArgType(iface.name) + ' self')}) {\n`;
    let call = attr.static ? `${iface.name}::${attr.cppName}` : `self->${attr.cppName}`;
    if (attr.idlType in valuetypes) {
      cpp += `  static ${attr.idlType} temp;\n`;
      cpp += `  temp = ${call};\n`;
      cpp += `  return &temp;\n`;
    } else {
      cpp += `  return ${call};\n`;
    }
    cpp += '}';

    if (!attr.isReadOnly) {
      let needTempHeapPtr = { value: false };
      let tempheap = MakeJSHeapPtrArg(0, attr.idlType, needTempHeapPtr);
      if (needTempHeapPtr.value)
        tempheap = 'tempHeapCache.prepare();    ' + tempheap;

      js += `\n  set ${attr.name}(arg0) {\n`;
      if (tempheap) js += '    ' + tempheap + '\n';
      js += `    _${CppPropNameFor(iface.name, attr.name, true)}(${attr.static ? '' : 'this.ptr, '}arg0);\n`;
      js += '  }';

      cpp += '\nvoid EMSCRIPTEN_KEEPALIVE ';
      cpp += `${CppPropNameFor(iface.name, attr.name, true)}(`;
      if (!attr.static) {
        cpp += `${CppSelfArgType(iface.name)} self, `;
      }
      cpp += `${CppArgType(attr.idlType)} arg0) {\n`;
      cpp += `  ${attr.static ? `${iface.name}::` : `self->`}${attr.cppName} = arg0;`;
      cpp += '}';
    }

    jsattrs.push(js);
    cppattrs.push(cpp);
  }

  return { js: jsattrs.join("\n"), cpp: cppattrs.join("\n") };
}

function handleInterface(iface) {
  let superclass = iface['inheritance'];

  let constructor = handleInterfaceConstructors(iface);
  let methods = handleInterfaceMethods(iface);
  let attributes = handleInterfaceAttributes(iface);
  let cache = `${PRIVATE}.${iface.name}___CACHE`;

  // some internal methods
  methods.jsmethods.push({
    isStatic: true,
    name: '__setCache',
    src: `(obj) {
  ${cache}[obj.ptr] = obj;
}`});

  methods.jsmethods.push({
    isStatic: true,
    name: '__wrap',
    src: `(ptr) {
  let obj = ${cache}[ptr];
  if (!obj) {
    obj = Object.create(${iface.name}.prototype);
    obj.ptr = ptr;
    ${cache}[ptr] = obj;
  }
  return obj;
}`});

  methods.jsmethods.push({
    isStatic: true,
    name: '__wrapNoCache',
    src: `(ptr) {
  obj = Object.create(${iface.name}.prototype);
  obj.ptr = ptr;
  return obj;
}`});

  if (!iface.noDestroy) {
    methods.jsmethods.push({
      name: 'destroy',
      src: `() {
  _${CppNameFor(iface.name, DESTRUCTOR, 0)}(this.ptr);
  delete ${cache}[this.ptr];
  delete this.ptr;
}`});
  }
    
  let js = `
${cache} = {};
${MODULE}.${iface.name} =
class ${iface.name} ${superclass ? `extends ${MODULE}.${superclass} ` : ''}{
  constructor${indentLines(constructor.js, '  ')}
${methods.jsmethods.map((m) => (m.isStatic ? '  static ' : '  ') + m.name + indentLines(m.src, '  ')).join("\n")}
${attributes.js}
};
`; // semicolon because we're assigning to ${MODULE}.${iface.name} as well

  // The C++ is simpler
  let cpp = [constructor.cpp, methods.cpp, attributes.cpp].join("\n");

  return { js: js, cpp: cpp };
}

function handleCallback(cb) {
  let rtype = resolveType(cb.idlType);
  let args = cb.arguments ? cb.arguments.map(resolveArgument) : [];
  let cppName = hasExtAttr(cb.extAttrs, "CppName");
  cppName = cppName ? cppName.rhs.value : cb.name;
  if (rtype == 'void') rtype = null;

  let js = `
${PRIVATE}.${cb.name}__next_token = 1;
${PRIVATE}.${cb.name}__cb_cache = {};
${PRIVATE}.${cb.name}__cb_map = {};
${PRIVATE}.${cb.name}__token_for_fn = function(fn) {
  if (typeof(fn) != 'function') throw 'Not a function';
  let token = ${PRIVATE}.${cb.name}__cb_cache[fn];
  if (!token) {
    token = ${PRIVATE}.${cb.name}__next_token++;
    ${PRIVATE}.${cb.name}__cb_map[token] = fn;
    ${PRIVATE}.${cb.name}__cb_cache[fn] = token;
  }
  return token;
};`;

  cb.CppCallWithTokenName = CppNameFor(cb.name, CALL_WITH_TOKEN, args.length);
  let cpp = `
${CppCallbackReturnType(rtype)} EMSCRIPTEN_KEEPALIVE
${cb.CppCallWithTokenName}(${ForNArgs(args, cb.name, ', ', (idx, name, arg) => (idx==0 ? 'long' : CppArgType(arg.type)) + ' ' + name)})
{
  `;

  let argnames = [];
  let conversions = ForNArgs(args, '\n    ', function (idx, cppname, arg) {
    let name = "$" + (idx+1);
    let m = makeJSFromCppValue(arg.type, name, true);
    if ((arg.type in interfaces) && interfaces[arg.type].sharedPtr) {
      argnames.push('&' + cppname);
    } else {
      argnames.push(cppname);
    }
    if (m != name) {
      return `${name} = ${m};`;
    }
    return undefined;
  });
  cpp += `${rtype ? 'return ' : ''}EM_ASM_({`;
  if (conversions)
    cpp += '\n    ' + conversions;
  cpp += `
    return ${PRIVATE}.${cb.name}__cb_map[$0](${ForNArgs(args, (idx, name, arg) => '$' + (idx+1))});
  }, self${argnames.length > 0 ? ', ' + argnames.join(', ') : ''});
}
`;

  return { js: js, cpp: cpp };
}

let nextOffset = 0;
let vtoffsets = [];

function handleValueType(vt)
{
  vt.sizeOfIndex = nextOffset++;
  vtoffsets.push({ sizeof: vt.cppName });

  let members = [];
  let curvt = vt;
  while (curvt) {
    for (let item of curvt.members) {
      if (item.type != 'attribute')
        continue;
      let name = item.name;
      let cppName = hasExtAttr(item.extAttrs, "CppName");
      cppName = cppName ? cppName.rhs.value : item.name;

      let type = resolveType(item.idlType);
      if (type in valuetypes)
        throw `valuetype ${curvt.name} contains other value type ${type} as member.  Not supported right now, but could be.`;
      if (type in interfaces)
        throw `valuetype ${curvt.name} contains non-valuetype interface ${type} as member.  Not supported, we can't get the memory management right.`;
      let cppType = CppBasicType(type);
      if (!type)
        throw `valuetype ${curvt.name} contains member ${name} with unsupported type ${type}`;

      let m = {
        name: name,
        cppName: cppName,
        type: type,
        cppType: cppType,
        cppBaseType: curvt.cppName,
      };

      if (item.offsetIndex === undefined) {
        item.offsetIndex = nextOffset++;
        vtoffsets.push(m);
      }

      m.offset = item.offsetIndex;
      members.push(m);
    }
    curvt = curvt.inheritance ? valuetypes[curvt.inheritance] : null;
  }

  function ForEachMember(fn) {
    let r = [];
    for (let m of members) {
      let initval = m.cppType == 'char *' ? '""' : 0;
      let heaptype, heapshift;
      switch (m.cppType) {
      case 'unsigned char':
      case 'char':
        heaptype = 'HEAP8'; heapshift = 0; break;
      case 'short':
      case 'unsigned short':
        heaptype = 'HEAP16'; heapshift = 1; break;
      case 'long':
      case 'unsigned long':
        heaptype = 'HEAP32'; heapshift = 2; break;
      case 'long long':
      case 'unsigned long long':
        throw `Can't support 64-bit long types right now`;
      case 'float':
        heaptype = 'HEAPF32'; heapshift = 2; break;
      case 'double':
        heaptype = 'HEAPF64'; heapshift = 3; break;
      case 'char *':
        throw 'Need to implement string support for value types';
      };

      let s = fn(m, m.name, initval, heaptype, heapshift);
      if (s && s != "") r.push(s);
    }
    return r;
  }

  let js = '';
  js += `
${MODULE}.${vt.name} =
class ${vt.name} {
  constructor() {
    ${ForEachMember((m, name, initjsval) => `this.${name} = ${initjsval};`).join('\n    ')}
  }
  static __fromPointer(ptr) {
    let v = new ${vt.name};
    ${ForEachMember((m, name, _, ht, hs) => `v.${name} = ${ht}[(ptr+${OFFSET_TABLE}[${m.offset}])>>${hs}];`).join('\n    ')}
    return v;
  }
  __toPointer(ptr) {
    ${ForEachMember((m, name, _, ht, hs) => `${ht}[(ptr+${OFFSET_TABLE}[${m.offset}])>>${hs}] = this.${name};`).join('\n    ')}
  }
};\n`; // semicolon because of the assignment before class

  let cpp = '';

  return { js: js, cpp: cpp };
}

function makeOffsetsTable()
{
  let cppFn = `${PFX}__GetOffsetTable`;
  let js = `
if (${vtoffsets.length}) {
  ${OFFSET_TABLE} = new Array(${vtoffsets.length});
  let base = _${cppFn}() >> 2;
  for (let i = 0; i < ${vtoffsets.length}; ++i) {
    ${OFFSET_TABLE}[i] = HEAP32[base + i];
  }
}`;

  let cpp = `size_t* EMSCRIPTEN_KEEPALIVE ${cppFn}() {
    static size_t v[] = {
      ${vtoffsets.map((m) => m.sizeof ? `sizeof(${m.sizeof})` : `offsetof(${m.cppBaseType}, ${m.cppName})`).join(',\n      ')}
    };
    return &v[0];
}`;

  return { js: js, cpp: cpp };
}

let bindings = [];

// preamble, largerly taken from Emscripten's webidl_bind
function jsPreamble()
{
    let js = `// AUTOMATICALLY GENERATED BY jsbindgen
// DO NOT EDIT

var ${MODULE} = ${MODULE} || {};
var ${PRIVATE} = ${PRIVATE} || {};

${PRIVATE}.tempHeapCache = {
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
  allocBytes: function(len) {
    assert(this.buffer);
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
    return ret;
  },
  allocForArray: function(array, view) {
    var bytes = view.BYTES_PER_ELEMENT;
    var len = array.length * bytes;
    var ret = this.allocBytes(len);
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

${PRIVATE}.tempHeapPtrString = function(value) {
  if (typeof value === 'string') return ${PRIVATE}.tempHeapCache.allocForArray(intArrayFromString(value), HEAP8);
  return value;
}
${PRIVATE}.tempHeapPtrI8 = function(value) {
  if (typeof value === 'object') return ${PRIVATE}.tempHeapCache.allocForArray(value, HEAP8);
  return value;
}
${PRIVATE}.tempHeapPtrI16 = function(value) {
  if (typeof value === 'object') return ${PRIVATE}.tempHeapCache.allocForArray(value, HEAP16);
  return value;
}
${PRIVATE}.tempHeapPtrI32 = function(value) {
  if (typeof value === 'object') return ${PRIVATE}.tempHeapCache.allocForArray(value, HEAP32);
  return value;
}
${PRIVATE}.tempHeapPtrF32 = function(value) {
  if (typeof value === 'object') return ${PRIVATE}.tempHeapCache.allocForArray(value, HEAPF32);
  return value;
}
${PRIVATE}.tempHeapPtrF64 = function(value) {
  if (typeof value === 'object') return ${PRIVATE}.tempHeapCache.allocForArray(value, HEAPF64);
  return value;
}
${PRIVATE}.tempHeapPtrBuffer = function(size) {
  return ${PRIVATE}.tempHeapCache.allocBytes(size);
}
`;

  return { js: js, cpp: "" };
}

/* ======
 * (main)
 * ======
 */
//console.log(prettyjson.render(tree));

let infile = process.argv[2];
let outbase = process.argv[3];
let modulename = process.argv[4] || "Module";
if (!outbase) {
  throw "need an output base filename";
}

setModuleName(modulename);

let infilestr = fs.readFileSync(process.argv[2], 'utf8');
let tree = webidl.parse(infilestr);

for (let item of tree) {
  if (item.type == 'interface') {
    let cppName = hasExtAttr(item.extAttrs, "CppName");
    item.cppName = cppName ? cppName.rhs.value : item.name;

    let sharedPtr = !!hasExtAttr(item.extAttrs, "SharedPtr");
    item.sharedPtr = sharedPtr;

    let valueType = !!hasExtAttr(item.extAttrs, "ValueType");
    if (valueType) {
      if (item.sharedPtr) throw "Value types can't be SharedPtr";
      valuetypes[item.name] = item;
    } else {
      interfaces[item.name] = item;
    }
  } else if (item.type == 'typedef') {
    typedefs[item.name] = item.idlType;
  } else if (item.type == 'callback') {
    callbacks[item.name] = item;
  }
}

// validate preconditions
for (let k of Object.keys(interfaces)) {
  let parent = interfaces[k].inheritance;
  if (!parent)
    continue;
  if (interfaces[parent].sharedPtr != interfaces[k].sharedPtr)
    throw `interfaces ${parent} and ${k} must both be sharedPtr if one is`;
}

for (let k of Object.keys(valuetypes)) {
  let vt = valuetypes[k];
  let parent = vt.inheritance;
  if (parent && !valuetypes[parent])
    throw `valuetype ${k} can only inherit from another value type (not ${parent})`;
  for (let m of vt.members) {
    if (m.type != 'attribute')
      throw `valuetype ${k} must only contain attributes (found ${m.name}: ${m.type})`;
    if (m.isReadOnly)
      throw `valuetype ${k} attr ${m.name} can't be readonly`;
  }
}

let OpaqueWrapperTypeInterface = {
  name: 'OpaqueWrapperType',
  members: [],
  extAttrs: [],
  noDestroy: true,
};
interfaces[OpaqueWrapperTypeInterface.name] = OpaqueWrapperTypeInterface;

//pp(tree);

bindings.push(jsPreamble());

for (let name of Object.keys(valuetypes)) {
  bindings.push(handleValueType(valuetypes[name]));
}

for (let name of Object.keys(callbacks)) {
  bindings.push(handleCallback(callbacks[name]));
}

for (let name of Object.keys(interfaces)) {
  bindings.push(handleInterface(interfaces[name]));
}

bindings.push(makeOffsetsTable());

let jsfd = fs.openSync(outbase + '.js', 'w');
for (let b of bindings) {
  fs.writeSync(jsfd, b.js);
}
fs.closeSync(jsfd);

let cppfd = fs.openSync(outbase + '.cpp', 'w');
fs.writeSync(cppfd, `// AUTOMATICALLY GENERATED BY jsbindgen
// DO NOT EDIT
#include <emscripten.h>
namespace {
template<class T>
std::shared_ptr<T>* jsbind_maybe_make_shared(const std::shared_ptr<T>& sp)
{
  if (!sp)
    return nullptr;
  return new std::shared_ptr<T>(sp);
}
}
extern "C" {`);

for (let b of bindings) {
  fs.writeSync(cppfd, b.cpp);
  fs.writeSync(cppfd, '\n\n');
}
fs.writeSync(cppfd, '\n}\n');
fs.closeSync(cppfd);

