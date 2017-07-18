## Overview

`idlebind` is a WebIDL JavaScript-to-C++ bindings generator.  It does not generate C++ headers; rather, it expects that the WebIDL describes methods and properties available on a particular C++ class and makes those accessible in JavaScript.

It has support for callbacks, `shared_ptr<T>` memory management, value types, static methods and properties, and other features.

It is still a work in progress.

## Setup & Usage

`idlebind` uses a few node.js packages.  A simple `npm install` is sufficient.  It is not currently published to npm.

To generate bindings:

>  `node idlebind.js source.idl out-gen`

This will process `source.idl` and generate bindings for all interfaces to `out-gen.js` and `out-gen.cpp`.  The JS file provides the JavaScript side interfaces, while the cpp file must be built along with the rest of the project and provides glue code.

## Details

### Shared Pointers
If an interface has the `[SharedPtr]` attribute, it is allocated and always referend via a `std::shared_ptr`.  Instances are passed to C++ code as `const std::shared_ptr<Type>`, and returned as `std::shared_ptr<Type>`.

### Value Types
Interfaces can be declared to be value types by including the `[Value]` attribute on the interface.  Such interfaces are not allowed to contain anything but simple data members.  They are passed to C++ code as `const Type&`, and returned as `Type`.  Additionally, they do not occupy any space on the C++ heap -- their values live only in JS, and are copied to/from temporary objects as needed during calls.

### Callbacks
Callbacks defined in the IDL can be passed as simple JavaScript functions.  The C++ receives these functions with appropriate parameter conversions as defined in the IDL.  In C++ code, they are `const std::function<ReturnType(Args...)>&` paramenters.

## Examples

See `test/test.idl`, `test/test.cpp`, and `test/test.js` for an example of how to write IDL corresponding to the classes defined in `test.cpp`, and how to use the resulting JS classes.

## LICENSE

`idlebind` is (C) 2017 Unity Technologies.  It is licensed under the MIT license.  See the `LICENSE` file for more details.
