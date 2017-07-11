#include <memory>
#include <functional>
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

class SharedClass : public std::enable_shared_from_this<SharedClass> {
public:
    SharedClass() { printf ("SharedClass()\n"); }
    ~SharedClass() { printf("~SharedClass()\n"); }
    long Thing() { printf("SharedClass::Thing()\n"); return 5; }
};

class ClassA {
public:
    ClassA() { printf("ClassA()\n"); }
    ClassA(int x, ClassB *p) { printf("ClassA(%d, %p)\n", x, p); }
    ClassA(const std::function<long(long)>& numfn) { foo = numfn(3); }

    ~ClassA() { printf("~ClassA()\n"); }

    static void StaticMethod() {
        printf("ClassA::StaticMethod()\n");
    }

    ClassB* MakeAB() {
        return new ClassB();
    }

    ClassC GetC() { return cc; }
    void SetC(ClassC& c) { cc = c; };

    std::shared_ptr<SharedClass> MakeShared() { return std::make_shared<SharedClass>(); }
    void DoShared(std::shared_ptr<SharedClass> sc) { sc->Thing(); }

    long AddOne(const std::function<long(long)>& numfn, long arg) {
        return numfn(arg) + 1;
    }

    long AddOneThing(const std::function<long(const std::shared_ptr<SharedClass>&)>& gfn, long arg) {
        auto thing = std::make_shared<SharedClass>();
        return gfn(thing) + arg;
    }

    ClassC cc;
    int foo;
    int bar;
    static int staticFoo;
};

int ClassA::staticFoo = 123;

#include "gen-bindings.cpp"
