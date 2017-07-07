#include <emscripten.h>

class ClassB {
public:
    ClassB() {}
    void Foo(int num) { printf("ClassB::Foo(%d)\n", num); }
};

class ClassBSub : public ClassB {
public:
    ClassBSub() {}
    void Bar(char *str) { printf("ClassBSub:Bar(%s)\n", str); }
};

struct ClassC {
    ClassC() : v(100) {}
    int v;
};

class ClassA {
public:
    ClassA() { printf("ClassA()\n"); }
    ClassA(int x) { printf("ClassA(%d)\n", x); }
    ClassA(int x, ClassB *p) { printf("ClassA(%d, %p)\n", x, p); }
    ~ClassA() { printf("~ClassA()\n"); }

    static void StaticMethod() {
        printf("ClassA::StaticMethod()\n");
    }

    ClassB* MakeAB() {
        return new ClassB();
    }

    ClassC GetC() { return cc; }
    void SetC(ClassC& c) { cc = c; };

    ClassC cc;
};

#include "gen-bindings.cpp"
