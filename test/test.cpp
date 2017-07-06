#include <emscripten.h>

class ClassB {
public:
    ClassB() {}
    void Foo(int num) { printf("ClassB::Foo(%d)\n", num); }
};

class ClassA {
public:
    ClassA() { printf("ClassA()\n"); }
    ~ClassA() { printf("~ClassA()\n"); }

    static void StaticMethod() {
        printf("ClassA::StaticMethod()\n");
    }

    ClassB* MakeAB() {
        return new ClassB();
    }
};

#include "gen-bindings.cpp"
