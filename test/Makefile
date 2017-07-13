all: out.js

EMCCFLAGS := -std=c++11

gen-bindings.cpp: test.idl ../bindgen.js Makefile
	node ../bindgen.js test.idl gen-bindings Bindings

out.js: test.cpp gen-bindings.cpp gen-bindings.js test.js Makefile
	emcc $(EMCCFLAGS) -o out-pre.js test.cpp
	cat out-pre.js gen-bindings.js test.js > out.js

