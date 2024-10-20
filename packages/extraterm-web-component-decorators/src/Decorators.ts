/*
 * Copyright 2020 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import * as reflect from "reflect-metadata";
require("reflect-metadata");  // Ensure that it is actually imported and not elided by tsc.


type FilterMethodName = string;
type ObserverMethodName = string;

type PropertyType = "unknown" | "String" | "Number" | "Boolean";

function jsTypeToPropertyType(name: string): PropertyType {
  if (name === "String" || name === "Number" || name === "Boolean") {
    return name;
  }
  return "unknown";
}

interface AttributeData {
  jsName: string;
  attributeName: string;
  attributeExists: boolean;
  dataType: PropertyType;
  hasGetter: boolean;
  hasSetter: boolean;
  instanceValueMap: WeakMap<any, any>;

  filters: FilterMethodName[];
  observers: ObserverMethodName[];
}

function kebabCase(name: string): string {
  return name.split(/(?=[ABCDEFGHIJKLMNOPQRSTUVWXYZ])/g).map(s => s.toLowerCase()).join("-");
}

const decoratorDataSymbol = Symbol("Custom Element Decorator Data");


/**
 * Class decorator for web components.
 *
 * This should appear at the top of classes which implement Custom Elements.
 *
 * @param tag The tag for this custom element written in kebab-case. As
 *            conform the Custom Element specification, this tag must contain
 *            a `-` (dash) character.
 */
export function CustomElement(tag: string): (target: any) => any {
  return function(constructor: CustomElementConstructor): any {
    const decoratorData = getDecoratorData(constructor.prototype);

    const interceptedConstructor = class extends constructor {
      constructor() {
        super();
        if (Object.getPrototypeOf(this).constructor === interceptedConstructor) {
          decoratorData.markInstanceConstructed(this);
        }
      }

      getAttribute(attrName: string): any {
        const result = decoratorData.getAttribute(this, attrName);
        if (result !== undefined) {
          return result;
        }
        return super.getAttribute(attrName);
      }

      setAttribute(attrName: string, value: any): void {
        if ( ! decoratorData.setAttribute(this, attrName, value)) {
          super.setAttribute(attrName, value);
        }
      }

      hasAttribute(attrName: string): boolean {
        const result = decoratorData.hasAttribute(this, attrName);
        return result === undefined ? super.hasAttribute(attrName) : result;
      }

      removeAttribute(attrName: string): void {
        if ( ! decoratorData.removeAttribute(this, attrName)) {
          super.removeAttribute(attrName);
        }
      }

      [decoratorData.superSetAttributeSymbol](attrName: string, value: any): void {
        super.setAttribute(attrName, value);
      }
    };

    decoratorData.validate();

    const tagLower = tag.toLowerCase();
    window.customElements.define(tagLower, interceptedConstructor);
    return interceptedConstructor;
  };
}

/**
 * Mark a field as an attribute.
 *
 * Calls to `setAttribute()` and `getAttribute()` will be set/get on this
 * field. Also `@Observe` and `@Filter` can be used to modify the setting
 * process.
 */
export function Attribute(prototype: any, key: string) {
  const decoratorData = getDecoratorData(prototype);
  decoratorData.installAttribute(prototype, key);
  return undefined;
}

function getDecoratorData(prototype: any): DecoratorData {
  if (prototype[decoratorDataSymbol] == null) {
    prototype[decoratorDataSymbol] = new DecoratorData(prototype);
  }
  return prototype[decoratorDataSymbol];
}


class DecoratorData {
  private _instanceConstructedMap = new WeakMap<any, boolean>();
  private _jsNameAttrDataMap = new Map<string, AttributeData>();
  //                              ^ Key is the js attribute name

  private _attrNameAttrDataMap = new Map<string, AttributeData>();
  //                                     ^ Key is a kebab-case attribute name.

  superSetAttributeSymbol = Symbol("SuperSetAttribute")

  constructor(private _elementProto: any) {
  }

  markInstanceConstructed(instance: any): void {
    this._instanceConstructedMap.set(instance, true);
  }

  private _isInstanceConstructed(instance: any): boolean {
    return this._instanceConstructedMap.get(instance);
  }

  installAttribute(prototype: any, jsName: string): void {
    const decoratorData = this;
    const attrData = this._getOrCreateAttributeData(jsName);

    let propertyType: PropertyType = "unknown";
    const propertyTypeMetadata = Reflect.getMetadata("design:type", prototype, jsName);
    if (propertyTypeMetadata != null) {
      propertyType = jsTypeToPropertyType(propertyTypeMetadata.name);
    }

    const descriptor = Object.getOwnPropertyDescriptor(prototype, jsName);
    const hasGetter = descriptor != null && descriptor.get !== undefined;
    const hasSetter = descriptor != null && descriptor.set !== undefined;

    attrData.hasGetter = hasGetter;
    attrData.hasSetter = hasSetter;
    attrData.dataType = propertyType;
    attrData.attributeExists = true;

    if ( ! (hasGetter || hasSetter)) {
      const getter = function(this: any): any {
        return attrData.instanceValueMap.get(this);
      };

      const setter = function(this: any, newRawValue: any): void {
        if ( ! decoratorData._isInstanceConstructed(this) && attrData.dataType === "unknown") {
          // Guess what the true data type for this attribute is. This is needed when TypeScript
          // infers the type of a property via its initializing value.
          if ((typeof newRawValue) === "number") {
            attrData.dataType = "Number";
          } else if ((typeof newRawValue) === "boolean") {
            attrData.dataType = "Boolean";
          } else if ((typeof newRawValue) === "string") {
            attrData.dataType = "String";
          }
        }

        let newValue: any = newRawValue;
        if (attrData.dataType === "Number" && ((typeof newValue) !== "number")) {
          newValue = parseFloat(newRawValue);
        } else if (attrData.dataType === "Boolean" && ((typeof newValue) !== "boolean")) {
          newValue = newRawValue === attrData.attributeName || newRawValue === "" || newRawValue === "true";
        }

        if (decoratorData._isInstanceConstructed(this)) {
          // Filter
          for (const methodName of attrData.filters) {
            const updatedValue = this[methodName].call(this, newValue, jsName);
            if (updatedValue === undefined) {
              return;
            }
            newValue = updatedValue;
          }
        }
        const oldValue = attrData.instanceValueMap.get(this);
        if (oldValue === newValue) {
          return;
        }

        attrData.instanceValueMap.set(this, newValue);
        if (decoratorData._isInstanceConstructed(this)) {
          this[decoratorData.superSetAttributeSymbol].call(this, attrData.attributeName, newValue);

          // Notify observers
          for (const methodName of attrData.observers) {
            this[methodName].call(this, jsName);
          }
        }
      };

      if (delete this._elementProto[jsName]) {
        Object.defineProperty(this._elementProto, jsName, {
          get: getter,
          set: setter,
          enumerable: true,
          configurable: true
        });
      }
    }
  }

  private _getOrCreateAttributeData(jsName: string): AttributeData {
    const registration = this._jsNameAttrDataMap.get(jsName);
    if (registration != null) {
      return registration;
    }

    const attributeName = kebabCase(jsName);
    const newRegistration: AttributeData = {
      jsName,
      attributeName,
      attributeExists: false,
      dataType: null,
      hasGetter: false,
      hasSetter: false,
      instanceValueMap: new WeakMap<any, any>(),
      filters: [],
      observers: [],
    };

    this._jsNameAttrDataMap.set(jsName, newRegistration);
    this._attrNameAttrDataMap.set(attributeName, newRegistration);
    return newRegistration;
  }

  getAttribute(instance: any, attrName: string): any {
    const attrData = this._attrNameAttrDataMap.get(attrName);
    if (attrData === undefined) {
      return undefined;
    }

    const value = attrData.hasGetter ? instance[attrData.jsName] : attrData.instanceValueMap.get(instance);
    if (attrData.dataType === "Boolean") {
      return value ? "" : null;
    }

    return value;
  }

  setAttribute(instance: any, attrName: string, value: any): boolean {
    const attrData = this._attrNameAttrDataMap.get(attrName);
    if (attrData === undefined) {
      return false;
    }

    if (attrData.hasGetter && ! attrData.hasSetter) {
      return false;
    }

    instance[attrData.jsName] = value;
    return true;
  }

  hasAttribute(instance: any, attrName: string) : boolean {
    const attrData = this._attrNameAttrDataMap.get(attrName);
    if (attrData === undefined) {
      return undefined;
    }
    if (attrData.dataType !== "Boolean") {
      return undefined;
    }
    return instance[attrData.jsName];
  }

  removeAttribute(instance: any, attrName: string) : boolean {
    const attrData = this._attrNameAttrDataMap.get(attrName);
    if (attrData === undefined) {
      return false;
    }
    if (attrData.dataType !== "Boolean") {
      return false;
    }
    instance[attrData.jsName] = false;
    return true;
  }

  registerObserver(jsPropertyName: string, methodName: string): void {
    const attrData = this._getOrCreateAttributeData(jsPropertyName);
    attrData.observers.push(methodName);
  }

  registerFilter(jsPropertyName: string, methodName: string): void {
    const attrData = this._getOrCreateAttributeData(jsPropertyName);
    attrData.filters.push(methodName);
  }

  validate(): void {
    for (const [jsName, attrData] of this._jsNameAttrDataMap) {
      if ( ! attrData.attributeExists) {
        for (const observerMethodName of attrData.observers) {
          console.warn(`Observer method '${observerMethodName}' is attached to undefined property '${jsName}'.`);
        }
        for (const filterMethodName of attrData.filters) {
          console.warn(`Filter method '${filterMethodName}' is attached to undefined property '${jsName}'.`);
        }
      } else {

        for (const filterMethodName of attrData.filters) {
          this._validateFilterMethod(attrData, filterMethodName);
        }
      }
    }
  }

  private _validateFilterMethod(attrData: AttributeData, filterMethodName: string): void {
    const methodParameters = Reflect.getMetadata("design:paramtypes", this._elementProto, filterMethodName);
    if (methodParameters != null) {
      if (methodParameters.length !== 1 && methodParameters.length !== 2) {
        console.warn(`Filter method '${filterMethodName}' on property '${attrData.jsName}' has the wrong number of parameters. It should have 1 or 2 instead of ${methodParameters.length}.`);
      } else {
        const firstParameterType = jsTypeToPropertyType(methodParameters[0].name);
        if (firstParameterType !== "unknown" && attrData.dataType !== "unknown" && firstParameterType !== attrData.dataType) {
          console.warn(`Filter method '${filterMethodName}' on property '${attrData.jsName}' has the wrong parameter type. Expected '${attrData.dataType}', found '${methodParameters[0].name}'.`);
        }
        if (methodParameters.length === 2) {
          if (methodParameters[1].name !== "String") {
            console.warn(`Filter method '${filterMethodName}' on property '${attrData.jsName}' has the wrong 2nd parameter type. Expected 'String', found '${methodParameters[1].name}'.`);
          }
        }
      }
    }

    // Check that the return type matches the attribute type.
    const returnTypeMeta = Reflect.getMetadata("design:returntype", this._elementProto, filterMethodName);
    if (returnTypeMeta != null) {
      const returnType = jsTypeToPropertyType(returnTypeMeta.name);
      if (returnType !== "unknown" && attrData.dataType !== "unknown" && attrData.dataType !== returnType) {
        console.warn(`Filter method '${filterMethodName}' on property '${attrData.jsName}' has the wrong return type. Expected '${attrData.dataType}', found '${returnType}'.`);
      }
    }
  }
}

/**
 * Method decorator for observing changes to a HTML attribute.
 *
 * The decorated method is called with one parameter; the name of the
 * attribute which changed. Note: The name is actually that of the
 * property. i.e. "someString" not "some-string".
 *
 * @param jsPropertyNames variable number of parameters naming the
 *                        attributes which this method observes.
 */
export function Observe(...jsPropertyNames: string[]) {
  return function (proto: any, methodName: string, descriptor: PropertyDescriptor) {
    const decoratorData = getDecoratorData(proto);
    for (const jsPropertyName of jsPropertyNames) {
      decoratorData.registerObserver(jsPropertyName, methodName);
    }
  };
}

/**
 * Method decorator to apply a filter to the value set on a HTML attribute.
 *
 * The method can have one or two parameters. The first is the value which
 * needs to be filtered. The second optional parameter is the name of the
 * attribute the value is for. The method must return the new filtered value,
 * or `undefined` to indicate that the new value should be rejected.
 *
 * Note that the filter doesn't affect the value of the HTML attribute set,
 * but it does affect the internal value directly accessible via the JS field.
 * Also these filters can only be used for attributes which have been created
 * using the `Attribute` decorator.
 *
 * @param jsPropertyNames variable number of parameters naming the attributes
 *                        which this method filters.
 */
export function Filter(...jsPropertyNames: string[]) {
  return function(proto: any, methodName: string, descriptor: PropertyDescriptor) {
    const decoratorData = getDecoratorData(proto);
    for (const jsPropertyName of jsPropertyNames) {
      decoratorData.registerFilter(jsPropertyName, methodName);
    }
  };
}
