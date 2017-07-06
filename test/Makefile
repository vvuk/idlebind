all: out.js

gen-bindings.cpp: test.idl ../bindgen.js
	node ../bindgen.js test.idl gen-bindings

out.js: test.cpp gen-bindings.cpp gen-bindings.js test.js
	emcc -o out.js test.cpp --post-js gen-bindings.js --post-js test.js
